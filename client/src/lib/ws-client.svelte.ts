// Instantiable WebSocket transport — extracted from the module-level singleton
// in `ws.svelte.ts` so the host coordinator (stages 3+) can own one WsClient
// per connected computer. Each instance has its own URL, connection state,
// reconnect/heartbeat timers, and message listeners.
//
// The module-level compatibility exports in `ws.svelte.ts` delegate to a single
// `WsClient` singleton, preserving the existing single-host behavior and all
// current importers (store, pull-to-refresh, delivery).
//
// The logic is a near-verbatim port of the original module-scope code: each
// module-scope reference (`_state`, `ws`, `listeners`, etc.) became `this.`-
// instance fields, and the global event listeners register/unregister per
// instance.

import {
  type ClientMessage,
  parseServerMessage,
  type ResumeToken,
  type ServerMessage,
} from "@pantoken/protocol";
import { getToken } from "./auth.js";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export type MessageListener = (msg: ServerMessage) => void;

/** The interface the host coordinator depends on. Tests inject a FakeWsClient
 *  that implements this without a real WebSocket — no DOM, no timers. */
export interface IWsClient {
  connectionState(): ConnectionState;
  reconnectAttempts(): number;
  connect(): void;
  forceReconnect(): void;
  disconnect(): void;
  send(msg: ClientMessage): boolean;
  onMessage(listener: MessageListener): () => void;
  setResumeProvider(fn: (() => ResumeToken | null) | null): void;
  destroy(): void;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;
const CONNECT_TIMEOUT_MS = 8_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_WATCHDOG_MS = 10_000;

export class WsClient implements IWsClient {
  private _state = $state<ConnectionState>("disconnected");
  private _reconnectAttempt = $state(0);

  private ws: WebSocket | null = null;
  private listeners: MessageListener[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Handshake watchdog: a blackholed connect (SYN into a dead Tailscale route)
  // can sit CONNECTING for minutes with NO retry timer armed — "Reconnecting…"
  // would lie. If the socket hasn't opened within the window, kill it and fall
  // back to the normal backoff schedule.
  private connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  // Heartbeat: a half-open socket (phone slept, NAT dropped the stream mid-sleep, no
  // FIN/RST ever arrives) sits in `_state === "connected"` forever — onclose/onerror never
  // fire, so the "live" indicator lies. While connected, ping on an interval; ANY inbound
  // frame (not just a reply pong) counts as proof of life, tracked in `lastInboundAt`. A
  // ping that gets no traffic back within the watchdog window means the transport is dead —
  // force it closed and fall into the normal reconnect/backoff flow, same remedy as the
  // handshake watchdog above.
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatWatchdog: ReturnType<typeof setTimeout> | null = null;
  private lastInboundAt = 0;
  private intentionalClose = false;
  // The store registers a provider for the focused session's fold watermark; the
  // (re)connect hello carries it so the server can tail-replay just the missed
  // events instead of re-shipping the whole transcript (protocol v2 resume).
  private resumeProvider: (() => ResumeToken | null) | null = null;

  /** Resolves the WS URL on each connect. Accepts a fixed string or a function
   *  (the compatibility singleton resolves dynamically via resolveWsUrl). */
  private readonly urlOrResolver: string | (() => string);

  /** Set by `ws.svelte.ts` when creating the compatibility-layer singleton.
   *  Bare dev-only test events (no `detail.hostId`) hit the singleton only,
   *  preserving existing e2e behavior; multi-host test dispatches include
   *  `detail.hostId` to target a specific instance. */
  isCompatibilitySingleton = false;

  /** Bound event handlers (so we can remove them on destroy). */
  private readonly boundVisibilityChange: () => void;
  private readonly boundPageshow: () => void;
  private readonly boundOnline: () => void;
  private readonly boundTestDisconnect: (e: Event) => void;
  private readonly boundTestReconnecting: (e: Event) => void;

  private destroyed = false;

  constructor(url: string | (() => string)) {
    this.urlOrResolver = url;
    this.boundVisibilityChange = this.handleVisibilityChange.bind(this);
    this.boundPageshow = this.handleWake.bind(this);
    this.boundOnline = this.handleWake.bind(this);
    this.boundTestDisconnect = this.handleTestDisconnect.bind(this);
    this.boundTestReconnecting = this.handleTestReconnecting.bind(this);
    this.registerGlobalListeners();
  }

  // ── Reactive state accessors ──────────────────────────────────────────

  connectionState(): ConnectionState {
    return this._state;
  }

  reconnectAttempts(): number {
    return this._reconnectAttempt;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  connect(): void {
    this.intentionalClose = false;
    this._reconnectAttempt = 0;
    this.doConnect();
  }

  /** User-requested reconnect: cancel any backoff and open a fresh socket now. */
  forceReconnect(): void {
    this.intentionalClose = false;
    this._reconnectAttempt = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const closing = this.ws;
      this.cleanupSocket();
      closing.close();
    }
    this.doConnect();
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const closing = this.ws;
      this.cleanupSocket();
      closing.close();
    }
    this._state = "disconnected";
  }

  /** Clean up all event listeners + timers. Called on teardown. */
  destroy(): void {
    this.destroyed = true;
    this.unregisterGlobalListeners();
    this.disconnect();
    this.listeners = [];
  }

  // ── Messaging ────────────────────────────────────────────────────────

  /** Send immediately when the authenticated socket is open. Callers that need
   *  reliability keep their own durable queue and retry when this returns false. */
  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  setResumeProvider(fn: (() => ResumeToken | null) | null): void {
    this.resumeProvider = fn;
  }

  // ── Internal transport logic (ported from ws.svelte.ts) ───────────────

  private getReconnectDelay(): number {
    const delay = Math.min(
      BASE_DELAY_MS * 2 ** this._reconnectAttempt,
      MAX_DELAY_MS,
    );
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.round(delay + jitter);
  }

  private resolveUrl(): string {
    return typeof this.urlOrResolver === "function"
      ? this.urlOrResolver()
      : this.urlOrResolver;
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    this._state = "reconnecting";
    const delay = this.getReconnectDelay();
    this._reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private clearConnectWatchdog(): void {
    if (this.connectWatchdog !== null) {
      clearTimeout(this.connectWatchdog);
      this.connectWatchdog = null;
    }
  }

  private clearHeartbeatWatchdog(): void {
    if (this.heartbeatWatchdog !== null) {
      clearTimeout(this.heartbeatWatchdog);
      this.heartbeatWatchdog = null;
    }
  }

  /** Stop the recurring ping + drop any pending watchdog. Called from `cleanupSocket` so
   *  every path that discards a socket also stops heartbeating the one it's replacing. */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.clearHeartbeatWatchdog();
  }

  /** Start heartbeating a freshly-connected socket. Called once per connection, right
   *  after the server's `hello` flips `_state` to "connected". */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastInboundAt = Date.now();
    this.heartbeatInterval = setInterval(() => {
      // Battery: skip the routine ping while backgrounded — a wake (visibilitychange/
      // pageshow/online) probes liveness explicitly instead, see handleWake below.
      if (typeof document !== "undefined" && document.hidden) return;
      this.probeLiveness();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Send a ping and arm a watchdog: if no inbound traffic (a pong or anything else)
   *  arrives before it fires, the socket is half-open — force-close it and fall back to
   *  the normal reconnect/backoff flow. At most one watchdog is ever pending; re-probing
   *  clears and re-arms it rather than stacking. */
  private probeLiveness(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const armedSocket = this.ws;
    const sentAt = Date.now();
    this.send({ type: "ping" });
    this.clearHeartbeatWatchdog();
    this.heartbeatWatchdog = setTimeout(() => {
      this.heartbeatWatchdog = null;
      // A replacement socket already took over — not this watchdog's problem.
      if (this.ws !== armedSocket) return;
      if (this.lastInboundAt >= sentAt) return; // traffic arrived after the ping — still alive
      console.warn(
        "[ws] heartbeat watchdog expired — socket looks half-open, forcing reconnect",
      );
      this.cleanupSocket(); // detaches onclose so the close below can't double-schedule
      armedSocket.close();
      this.scheduleReconnect();
    }, HEARTBEAT_WATCHDOG_MS);
  }

  private cleanupSocket(): void {
    // Every path that discards a socket (close, force-reconnect, disconnect)
    // also invalidates its handshake watchdog and heartbeat.
    this.clearConnectWatchdog();
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws = null;
    }
  }

  private doConnect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    )
      return;
    this.cleanupSocket();
    // A hidden tab skips connecting to save resources (e.g. a backgrounded PWA).
    // But under the Vite dev server the preview/automation tab runs permanently
    // backgrounded (visibilityState stays "hidden", no visibilitychange ever
    // fires), so this guard would wedge it "Offline" forever. Always connect in
    // dev; the prod bundle keeps the battery guard.
    if (!import.meta.env.DEV && document.visibilityState === "hidden") return;

    const url = this.resolveUrl();
    this._state = this._reconnectAttempt === 0 ? "connecting" : "reconnecting";
    this.ws = new WebSocket(url);

    // Arm the handshake watchdog for THIS socket. The identity guard matters:
    // forceReconnect may have swapped the socket before the timer fires, and the
    // watchdog must never kill a replacement it didn't arm for.
    const armed = this.ws;
    this.clearConnectWatchdog();
    this.connectWatchdog = setTimeout(() => {
      this.connectWatchdog = null;
      if (this.ws !== armed || armed.readyState !== WebSocket.CONNECTING) return;
      console.warn("[ws] connect timed out — closing and retrying with backoff");
      this.cleanupSocket(); // detaches onclose so the close below can't double-schedule
      armed.close();
      // Deliberately NOT resetting _reconnectAttempt: a timed-out handshake is a
      // failed attempt, so the backoff keeps growing.
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    this.ws.onopen = () => {
      this.clearConnectWatchdog();
      this._reconnectAttempt = 0;
      this.send({
        type: "hello",
        auth: getToken() ?? undefined,
        resume: this.resumeProvider?.() ?? undefined,
      });
    };

    this.ws.onmessage = (event: MessageEvent) => {
      // ANY inbound frame is proof of life for the heartbeat watchdog — stamped before
      // parsing so even a frame we fail to make sense of still counts (a parse failure
      // below just means it isn't forwarded to listeners).
      this.lastInboundAt = Date.now();
      const msg = parseServerMessage(event.data as string);
      if (!msg) return;
      // OPEN only means the transport is up. Treat the socket as usable after the
      // server's authenticated hello, so durable prompts never race ahead of auth.
      if (msg.type === "hello") {
        this._state = "connected";
        this.startHeartbeat();
      }
      for (const listener of this.listeners) {
        try {
          listener(msg);
        } catch (e) {
          console.error("[ws] listener error:", e);
        }
      }
    };

    this.ws.onclose = () => {
      this.cleanupSocket();
      if (!this.intentionalClose) this.scheduleReconnect();
      else this._state = "disconnected";
    };

    this.ws.onerror = (event) => console.error("[ws] error:", event);
  }

  // ── Wake / visibility / online handlers ───────────────────────────────

  /** A wake signal (tab foregrounded, bfcache restore, network back) is exactly when a
   *  half-open socket's lie matters most: `_state` says "connected" whether or not the
   *  transport underneath still works, and a phone that just woke is the textbook case
   *  (NAT dropped the stream while asleep, no FIN/RST ever arrived). Don't trust it —
   *  if it claims connected, probe right now instead of waiting for the next heartbeat
   *  tick; the probe's own watchdog forces a reconnect if nothing answers. If it's
   *  anything else, skip the probe and reconnect immediately, like the manual Reconnect
   *  button — no reason to ride out the accumulated backoff for an obvious fresh wake. */
  private handleWake(): void {
    if (this.intentionalClose) return;
    if (this._state !== "connected") {
      this.forceReconnect();
      return;
    }
    this.probeLiveness();
  }

  private handleVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    } else {
      this.handleWake();
    }
  }

  // ── Dev-only test hooks ───────────────────────────────────────────────

  /** Deterministic e2e hook: simulate a transport loss without taking HTTP/Vite
   *  offline, so the test can close and reopen the page around a durable queued prompt.
   *  Bare events (no detail.hostId) hit the compatibility singleton only; multi-host
   *  test dispatches include detail.hostId to target a specific instance. */
  private handleTestDisconnect(e: Event): void {
    const detail = (e as CustomEvent).detail as
      | { hostId?: string }
      | undefined;
    if (detail?.hostId) {
      // Targeted at a specific instance — only act if this is it.
      // (The coordinator dispatches with hostId for multi-host tests.)
      return; // The coordinator handles targeted dispatches itself.
    }
    // Bare event — only the compatibility singleton acts (preserves e2e behavior).
    if (!this.isCompatibilitySingleton) return;
    this.disconnect();
  }

  /** Deterministic e2e hook: freeze the socket in "reconnecting" (dropped but actively
   *  retrying) so a queued prompt renders "Sending when reconnected…". Suppress the real
   *  retry/online/visibility auto-reconnect so the state holds for the assertion. */
  private handleTestReconnecting(e: Event): void {
    const detail = (e as CustomEvent).detail as
      | { hostId?: string }
      | undefined;
    if (detail?.hostId) {
      return; // Targeted dispatch — coordinator handles.
    }
    if (!this.isCompatibilitySingleton) return;
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const closing = this.ws;
      this.cleanupSocket();
      closing.close();
    }
    this._state = "reconnecting";
  }

  // ── Global listener registration ─────────────────────────────────────

  private registerGlobalListeners(): void {
    if (typeof document === "undefined" || typeof window === "undefined")
      return;
    document.addEventListener("visibilitychange", this.boundVisibilityChange);
    // bfcache restore (e.g. iOS Safari switching apps and back) can land here without
    // ever firing visibilitychange — pageshow is the reliable signal for that case.
    window.addEventListener("pageshow", this.boundPageshow);
    // A network flap (cell↔wifi over Tailscale) fires 'online' the moment the OS has
    // connectivity again — usually well before the next backoff tick. Probe/reconnect
    // eagerly instead of riding out the timer.
    window.addEventListener("online", this.boundOnline);
    if (import.meta.env.DEV) {
      window.addEventListener(
        "pantoken:test-disconnect",
        this.boundTestDisconnect,
      );
      window.addEventListener(
        "pantoken:test-reconnecting",
        this.boundTestReconnecting,
      );
    }
  }

  private unregisterGlobalListeners(): void {
    if (typeof document === "undefined" || typeof window === "undefined")
      return;
    document.removeEventListener("visibilitychange", this.boundVisibilityChange);
    window.removeEventListener("pageshow", this.boundPageshow);
    window.removeEventListener("online", this.boundOnline);
    if (import.meta.env.DEV) {
      window.removeEventListener(
        "pantoken:test-disconnect",
        this.boundTestDisconnect,
      );
      window.removeEventListener(
        "pantoken:test-reconnecting",
        this.boundTestReconnecting,
      );
    }
  }
}
