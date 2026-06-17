// The session hub: holds the authoritative folded SessionState, folds every
// driver event into it, and fans events out to all connected WS clients. New
// clients get hello + a full snapshot so they catch up without replaying history.

import {
  type ClientMessage,
  foldEvent,
  initialSessionState,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionDriverEvent,
  type SessionId,
  type SessionState,
} from "@pilot/protocol";
import type { PilotDriver } from "./driver.js";

export type Send = (msg: ServerMessage) => void;

/** What the hub hands to a notifier (e.g. the Web Push sender) for notable events. */
export interface HubNotification {
  title: string;
  body: string;
  tag?: string;
}

export class SessionHub {
  // The FOCUSED session's folded state — what every client sees (D8: global focus).
  // Background sessions stream live inside the driver (kept warm); they reach the hub
  // only so a finished background turn can still notify a closed phone.
  private state: SessionState = initialSessionState();
  private focusedId: SessionId | null = null;
  private clients = new Set<Send>();
  private serverId = `pilot-${Math.floor(Date.now() / 1000)}`;
  // Whether any client has connected since startup. Gates push so replayed history
  // — the mock's bootstrap greeting, or the pi driver's on-load session replay
  // (both can end in runCompleted while clientCount is 0) — doesn't buzz a stored
  // subscription on every restart. This is also how replay is told apart from live
  // events (D13): cold-start seeds fold before anyone connects, and switchTo folds
  // its seed directly rather than through onEvent, so neither reaches maybeNotify.
  private everConnected = false;
  // True only during a session swap: ignore stray driver events while we reset and
  // re-fold the new session's seed, so a half-switched state is never broadcast.
  private switching = false;

  constructor(
    private driver: PilotDriver,
    // Called on run-done / approval-needed when NO client is connected, i.e. every
    // surface is backgrounded/closed — exactly when a Web Push should reach a pocket.
    private notify?: (n: HubNotification) => void,
  ) {
    driver.subscribe((ev) => this.onEvent(ev));
  }

  private onEvent(ev: SessionDriverEvent): void {
    if (this.switching) return; // the swap orchestrates its own reset + re-fold
    const sid = ev.sessionRef.sessionId;
    // The first session to surface becomes the focus (e.g. the resumed session at
    // startup). Only the focused session folds into `state` and broadcasts; other
    // (warm, background) sessions reach maybeNotify but not the focused transcript.
    if (this.focusedId === null) this.focusedId = sid;
    if (sid === this.focusedId) {
      foldEvent(this.state, ev);
      this.broadcast({ type: "event", event: ev });
    }
    this.maybeNotify(ev);
  }

  // Mirror of the client's tab-open notify rules (App.svelte), but server-side and
  // only when no client is connected — a foreground tab handles its own buzzing.
  private maybeNotify(ev: SessionDriverEvent): void {
    // Push only when someone has been here and then left — never on a cold replay
    // (no one to "return" to a backgrounded app that was never opened).
    if (!this.notify || this.clients.size > 0 || !this.everConnected) return;
    if (ev.type === "runCompleted")
      this.notify({
        title: "pilot",
        body: "Agent finished its turn",
        tag: "pilot-run",
      });
    else if (ev.type === "runFailed")
      this.notify({ title: "pilot", body: "Run failed", tag: "pilot-run" });
    else if (ev.type === "hostUiRequest") {
      const kind = ev.request.kind;
      if (
        kind === "confirm" ||
        kind === "select" ||
        kind === "input" ||
        kind === "editor"
      ) {
        const r = ev.request as { title?: string };
        this.notify({
          title: "Approval needed",
          body: r.title ?? "Waiting on you",
          tag: "pilot-approval",
        });
      }
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const send of this.clients) {
      try {
        send(msg);
      } catch (e) {
        console.error("[hub] send failed", e);
      }
    }
  }

  /** Fetch + broadcast the models available to switch to (driver-authoritative). */
  private async broadcastModelList(): Promise<void> {
    try {
      const models = await this.driver.listModels();
      this.broadcast({ type: "modelList", models });
    } catch (e) {
      console.error("[hub] listModels failed", e);
    }
  }

  /** Re-scan available sessions and broadcast the list + the active session id
   *  (derived from the folded state, so the picker's "active" row is authoritative). */
  private async broadcastSessionList(): Promise<void> {
    try {
      const sessions = await this.driver.listSessions();
      this.broadcast({
        type: "sessionList",
        sessions,
        activeSessionId: this.focusedId,
      });
    } catch (e) {
      console.error("[hub] listSessions failed", e);
    }
  }

  /**
   * Atomically switch the active session: run the driver swap (which resolves with
   * the new session's seed events), reset state, fold the seed, then re-snapshot all
   * clients and refresh the list. `switching` suppresses any stray events meanwhile.
   * The swap is server-authoritative — every connected client follows along.
   */
  private async switchTo(
    swap: () => Promise<SessionDriverEvent[]>,
  ): Promise<void> {
    this.switching = true;
    let seed: SessionDriverEvent[];
    try {
      seed = await swap();
    } catch (e) {
      this.switching = false;
      this.broadcast({ type: "error", message: `session switch failed: ${e}` });
      return;
    }
    this.state = initialSessionState();
    for (const ev of seed) foldEvent(this.state, ev);
    // Focus follows the swapped-to session; its id rides the seed's sessionOpened.
    this.focusedId = this.state.ref?.sessionId ?? this.focusedId;
    this.switching = false;
    this.broadcast({ type: "snapshot", state: this.snapshot() });
    await this.broadcastSessionList();
  }

  /** Register a client. Synchronously sends hello + snapshot, then live events. */
  addClient(send: Send): () => void {
    this.clients.add(send);
    this.everConnected = true;
    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      serverId: this.serverId,
    });
    send({ type: "snapshot", state: this.snapshot() });
    // Fire the session + model lists asynchronously (driver disk/registry reads); they
    // arrive as follow-up messages, keeping hello+snapshot synchronous + first.
    void this.broadcastSessionList();
    void this.broadcastModelList();
    return () => this.clients.delete(send);
  }

  handleClient(send: Send, msg: ClientMessage): void {
    switch (msg.type) {
      case "hello":
      case "ping":
        return;
      case "prompt":
        this.driver.prompt(
          msg.text,
          msg.deliverAs,
          msg.sessionId ?? this.focusedId ?? undefined,
        );
        return;
      case "abort":
        this.driver.abort(msg.sessionId ?? this.focusedId ?? undefined);
        return;
      case "respondUi": {
        // First-responder-wins: only the first answer for a still-pending dialog
        // reaches the driver. A second device answering the same id is dropped, so
        // the real pi session never gets a double resolution. The dialog lives in
        // the focused session's state (the only one clients can see + answer).
        const id = msg.response.requestId;
        if (!this.state.pendingApprovals.some((p) => p.requestId === id))
          return;
        this.driver.respondUi(
          msg.response,
          msg.sessionId ?? this.focusedId ?? undefined,
        );
        return;
      }
      case "setModel":
        this.driver.setModel(
          msg.provider,
          msg.modelId,
          msg.sessionId ?? this.focusedId ?? undefined,
        );
        return;
      case "setThinking":
        this.driver.setThinking(
          msg.level,
          msg.sessionId ?? this.focusedId ?? undefined,
        );
        return;
      case "openSession":
        void this.switchTo(() => this.driver.openSession(msg.path));
        return;
      case "newSession":
        void this.switchTo(() => this.driver.newSession(msg.cwd));
        return;
      case "listSessions":
        void this.broadcastSessionList();
        return;
      case "mock":
        this.driver.runScript?.(msg.script);
        return;
      default:
        send({
          type: "error",
          message: `unknown message: ${(msg as { type: string }).type}`,
        });
    }
  }

  /** Dev/test-only: clear state, replay the initial fixture, re-snapshot clients. */
  reset(): void {
    this.state = initialSessionState();
    this.focusedId = null;
    this.driver.reset?.();
    this.broadcast({ type: "snapshot", state: this.snapshot() });
  }

  /** A JSON-safe deep copy of current state (foldEvent mutates in place). */
  snapshot(): SessionState {
    return structuredClone(this.state);
  }

  clientCount(): number {
    return this.clients.size;
  }
}
