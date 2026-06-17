// The real driver: keeps N independent pi AgentSessions warm and presents them through
// PilotDriver, the same seam the mock implements. Selected via PILOT_DRIVER=pi. Uses the
// user's existing pi config (model + credentials from ~/.pi) unless overridden.
//
// D8 increment 2: instead of a single runtime that disposes the old session on every
// switch, we hold a `Map<sessionId, WarmSession>` of fully-independent sessions, each with
// its own cwd-bound services (trust resolver per cwd), UI bridge, and event subscription.
// They all stream concurrently into the shared `emit`; every event carries its session's
// ref, so the hub folds only the focused one but still lets a background run notify a
// closed phone. `openSession`/`newSession` warm-and-focus (create on first touch, reuse
// after); `prompt`/`abort`/`respondUi` dispatch by sessionId. Nothing is disposed on a
// switch — a backgrounded session keeps running and is instantly re-focusable with its
// full transcript. (No eviction yet: N is small for a single user; a warm-cap is a
// fast-follow if it ever isn't.)
//
// This replaces the old runtime-swap model: AgentSessionRuntime exists precisely to
// replace+dispose the active session, which is the opposite of keeping N warm.

import { basename } from "node:path";
import {
  type AgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionUIContext,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  HostUiResponse,
  SessionDriverEvent,
  SessionId,
  SessionListEntry,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
} from "@pilot/protocol";
import type { PilotDriver } from "../driver.js";
import { mapPiEvent } from "./event-map.js";
import { type HistoryMessage, historyToEvents } from "./history-map.js";
import { makeTrustResolver } from "./trust.js";
import { PiUiBridge } from "./ui-bridge.js";

export interface PiDriverOptions {
  cwd?: string;
}

// One kept-warm session and everything bound to it. Fully independent: its own
// AgentSession, UI bridge, and event subscription. `ref`/`cwd` are fixed for the
// session's lifetime — there is no swap, so nothing here is ever rebound.
interface WarmSession {
  session: AgentSession;
  ref: SessionRef;
  cwd: string;
  bridge: PiUiBridge;
  unsubscribe: () => void;
}

export async function createPiDriver(
  opts: PiDriverOptions = {},
): Promise<PilotDriver> {
  // The operator-launched cwd is implicitly trusted; sessions opened from other cwds
  // are gated by the per-session trust resolver below (D12).
  const launchCwd = opts.cwd ?? process.cwd();
  const agentDir = getAgentDir();
  const now = () => String(Date.now());

  const listeners = new Set<(ev: SessionDriverEvent) => void>();
  const emit = (ev: SessionDriverEvent) => {
    for (const l of listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[pi] listener error", e);
      }
    }
  };

  // Every kept-warm session, keyed by sessionId. Created on first touch (startup
  // resume, newSession, or openSession); never disposed on a focus switch.
  const warm = new Map<SessionId, WarmSession>();
  // Fallback target when a command arrives without a sessionId (the hub normally
  // passes the focused id). Tracks the most-recently focused/created session.
  let currentId: SessionId | null = null;

  // Snapshot for one warm session at a given status. Reads the session live so
  // model/title/thinking changes show up whenever a snapshot is taken.
  const snapshotFor = (
    ws: WarmSession,
    status: SessionStatus,
  ): SessionSnapshot => {
    const m = ws.session.model;
    return {
      ref: ws.ref,
      workspace: {
        workspaceId: ws.cwd,
        path: ws.cwd,
        displayName: basename(ws.cwd),
      },
      title: ws.session.sessionName ?? "pi session",
      status,
      updatedAt: now(),
      config: {
        provider: m && typeof m.provider === "string" ? m.provider : undefined,
        modelId: m?.id,
        thinkingLevel: ws.session.thinkingLevel,
      },
    };
  };

  const toolMetaFor = (ws: WarmSession, name: string) => {
    const t = ws.session.getAllTools().find((x) => x.name === name);
    return { label: undefined, description: t?.description };
  };

  // The seed for a warm session: a sessionOpened snapshot + its replayed history.
  // Emitted to the first subscriber for the startup session; returned (not emitted)
  // from openSession/newSession so the hub resets state and folds it atomically.
  const seedFor = (ws: WarmSession): SessionDriverEvent[] => [
    {
      sessionRef: ws.ref,
      timestamp: now(),
      type: "sessionOpened",
      snapshot: snapshotFor(ws, ws.session.isStreaming ? "running" : "idle"),
    },
    ...historyToEvents(
      ws.session.messages as unknown as readonly HistoryMessage[],
      {
        ref: ws.ref,
        idleSnapshot: snapshotFor(ws, "idle"),
        toolMeta: (name) => toolMetaFor(ws, name),
      },
    ),
  ];

  // Warm up a brand-new session from a SessionManager: create cwd-bound services (with
  // the per-cwd trust resolver), build the session, bind the UI bridge for approvals,
  // and subscribe its event stream into the shared emit. The cwd is taken from the
  // manager so an opened session is bound to ITS stored cwd, not launchCwd. Registers
  // and returns the WarmSession.
  async function warmUp(sessionManager: SessionManager): Promise<WarmSession> {
    const cwd = sessionManager.getCwd();
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      // Without this, pi leaves projectTrusted=true and auto-loads every project's .pi
      // resources — the D12 gap. Resolve trust per cwd instead (non-interactive MVP;
      // honors trust.json, trusts launchCwd, denies other untrusted paths).
      resourceLoaderReloadOptions: {
        resolveProjectTrust: makeTrustResolver(cwd, cwd === launchCwd),
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
    });

    const ref: SessionRef = { workspaceId: cwd, sessionId: session.sessionId };
    const bridge = new PiUiBridge(ref, emit, now);
    const ws: WarmSession = {
      session,
      ref,
      cwd,
      bridge,
      unsubscribe: () => {},
    };

    // Extension UI calls (approvals + ambient) flow through this session's bridge;
    // binding is per-AgentSession and required for hostUiRequest to reach clients.
    await session.bindExtensions({
      uiContext: bridge as unknown as ExtensionUIContext,
    });
    ws.unsubscribe = session.subscribe((ev) => {
      for (const out of mapPiEvent(ev, {
        ref,
        now,
        toolMeta: (name) => toolMetaFor(ws, name),
        snapshot: (status) => snapshotFor(ws, status),
      })) {
        emit(out);
      }
    });

    warm.set(session.sessionId, ws);
    console.log(
      `[pi] warmed session ${session.sessionId} (${cwd}); ${warm.size} warm`,
    );
    return ws;
  }

  // Resolve the warm session a command targets: the explicit id, else the driver's
  // current focus. Returns null (caller drops) if neither resolves — loud, not silent.
  const target = (sessionId?: SessionId): WarmSession | null => {
    const id = sessionId ?? currentId;
    const ws = id ? warm.get(id) : undefined;
    if (!ws) {
      console.error(`[pi] no warm session for id=${id ?? "(none)"}`);
      return null;
    }
    return ws;
  };

  // Startup: resume the most recent session for launchCwd (or a fresh one if none),
  // writing to ~/.pi/agent/sessions/ so an SSH `pi` peer sees the same files (D13).
  const initial = await warmUp(SessionManager.continueRecent(launchCwd));
  currentId = initial.ref.sessionId;

  const toEntry = (
    info: Awaited<ReturnType<typeof SessionManager.list>>[number],
  ): SessionListEntry => ({
    sessionId: info.id,
    path: info.path,
    cwd: info.cwd,
    displayName: info.name,
    preview: info.firstMessage ?? "",
    messageCount: info.messageCount,
    updatedAt: info.modified.toISOString(),
    createdAt: info.created.toISOString(),
    parentSessionPath: info.parentSessionPath,
  });

  return {
    subscribe(l) {
      listeners.add(l);
      // Seed the first (only) subscriber — the hub — synchronously with the startup
      // session so no live event races ahead of the initial transcript.
      if (listeners.size === 1) for (const ev of seedFor(initial)) emit(ev);
      return () => listeners.delete(l);
    },

    prompt(text, deliverAs, sessionId) {
      const ws = target(sessionId);
      if (!ws) return;
      emit({
        sessionRef: ws.ref,
        timestamp: now(),
        type: "userMessage",
        id: `u-${now()}`,
        text,
      });
      const options =
        ws.session.isStreaming && deliverAs
          ? { streamingBehavior: deliverAs }
          : undefined;
      ws.session.prompt(text, options).catch((e) => {
        emit({
          sessionRef: ws.ref,
          timestamp: now(),
          type: "runFailed",
          error: { message: String(e) },
        });
      });
    },

    abort(sessionId) {
      target(sessionId)
        ?.session.abort()
        .catch(() => {});
    },

    respondUi(response: HostUiResponse, sessionId) {
      target(sessionId)?.bridge.resolve(response);
    },

    async listSessions() {
      // Sessions for THIS workspace (listAll() spans every project — too broad here).
      const infos = await SessionManager.list(launchCwd);
      return infos.map(toEntry);
    },

    async openSession(path: string) {
      // Already warm (matched by session file)? Just refocus — never open a second
      // AgentSession on the same JSONL; that would double-write the file. This is the
      // instant focus-switch for a backgrounded session, history and all.
      const existing = [...warm.values()].find(
        (w) => w.session.sessionFile === path,
      );
      if (existing)
        console.log(`[pi] refocus warm session ${existing.ref.sessionId}`);
      const ws = existing ?? (await warmUp(SessionManager.open(path)));
      currentId = ws.ref.sessionId;
      return seedFor(ws);
    },

    async newSession() {
      const ws = await warmUp(SessionManager.create(launchCwd));
      currentId = ws.ref.sessionId;
      return seedFor(ws);
    },
  };
}
