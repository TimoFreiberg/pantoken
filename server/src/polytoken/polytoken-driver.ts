// The PolytokenDriver: a PilotDriver backed by an out-of-process polytoken daemon.
//
// polytoken is a daemon-first coding agent with a versioned OpenAPI 3.1 HTTP surface
// + an SSE event stream; the TUI is just one client of it. So this driver is mostly an
// HTTP+SSE client that maps polytoken's event vocabulary onto pilot's SessionDriverEvent.
//
// Chunk 1 scope: the one-session HAPPY PATH — spawn a daemon, claim the lease
// (+ heartbeat), subscribe to /events, `prompt`, `abort`, and a minimal event-fold.
// Chunk 2 (this revision): the FULL 57-variant event-fold is extracted into a pure
// `mapDaemonEvent` (event-map.ts), and this driver is now just the I/O glue — it
// feeds SSE envelopes to the pure mapper and EXECUTES the returned effect descriptors
// (fetchState, reseed, refetchQueue). The richer PilotDriver methods (sessions,
// models, permissions, history) are later chunks.
//
// Process model (spike §1): one daemon = one session = one port. This driver keeps a
// Map<SessionId, WarmSession> — for now there's at most one entry (the warm pool
// with a cap + idle reaper is Chunk 4). Cold (not-spawned) sessions are not yet listed.

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CommandInfo,
  DirListing,
  ExtensionInfo,
  FileInfo,
  HostUiResponse,
  ImageContent,
  ModelDefaults,
  ModelOption,
  PathStat,
  ProviderInfo,
  SessionDriverEvent,
  SessionId,
  SessionListEntry,
  SessionUsage,
  TreeSnapshot,
  WorkspaceRef,
} from "@pilot/protocol";
import {
  DaemonClient,
  spawnDaemon,
  type SseEnvelope,
  type SessionStateSnapshot as DaemonStateSnapshot,
} from "./daemon-client.js";
import type { NewSessionOpts, OAuthLoginIO, PilotDriver, TrustEvent } from "../driver.js";
import {
  type FoldAccumulator,
  buildPostFetchEvent,
  createAccumulator,
  mapDaemonEvent,
  resetAccumulator,
  snapshotFromState,
} from "./event-map.js";

interface PolytokenDriverOptions {
  /** Path to the polytoken binary. Defaults to "polytoken" ($PATH lookup). */
  bin?: string;
  /** Max warm daemons before LRU eviction. Chunk 4 honors this; Chunk 1 holds one. */
  warmCap?: number;
}

/** A warm (spawned) daemon session + its pilot-side metadata. */
interface WarmSession {
  client: DaemonClient;
  /** pilot's sessionRef for this session — threaded onto every emitted event. */
  ref: { workspaceId: string; sessionId: string };
  /** The workspace path (the daemon's --working-dir). */
  cwd: string;
  /** SSE unsubscribe, held so the driver can tear it down on close. */
  unsub: (() => void) | null;
  /** The event-fold accumulator — per-session working memory for content-block
   *  streaming (block kind, tool-input buffer, turn-error state). */
  acc: FoldAccumulator;
  /** Cached last-known daemon state snapshot. Kept fresh by fetchState effects +
   *  updated whenever the driver reads GET /state. Lets ctx.snapshot() be
   *  synchronous (the pure mapper never does I/O). */
  lastState: DaemonStateSnapshot | null;
}

export async function createPolytokenDriver(
  opts: PolytokenDriverOptions = {},
): Promise<PilotDriver> {
  const polytokenBin = opts.bin ?? "polytoken";
  const warmCap = opts.warmCap ?? 8;

  // Listeners — the hub subscribes once and folds whatever the driver emits.
  const listeners = new Set<(ev: SessionDriverEvent) => void>();
  const emit = (ev: SessionDriverEvent) => {
    for (const l of listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[polytoken] listener error", e);
      }
    }
  };

  // The warm session pool. Chunk 1 holds at most one; the cap + LRU reaper is Chunk 4.
  const warm = new Map<string, WarmSession>();
  let activeSessionId: string | null = null;

  const now = () => new Date().toISOString();

  /** Build a workspace ref object for a warm session. */
  function workspaceFor(ws: WarmSession): WorkspaceRef {
    return {
      workspaceId: ws.ref.workspaceId,
      path: ws.cwd,
      displayName: ws.cwd.replace(/\/+$/, "").split("/").pop() || ws.cwd,
    };
  }

  /** Derive pilot's SessionStatus from the cached daemon state snapshot. Uses the
   *  daemon's authoritative `turn_in_flight` flag (spike §7) rather than inferring
   *  from events — the daemon knows its own turn state. */
  function statusFromState(state: DaemonStateSnapshot | null): "idle" | "running" {
    return state?.turn_in_flight ? "running" : "idle";
  }

  /**
   * The event-fold: feed a polytoken SSE envelope to the pure mapper, emit its
   * returned pilot events, then execute its returned effect descriptors (which
   * involve I/O the pure mapper can't do). The mapper is the testable heart
   * (event-map.ts); this is the I/O glue.
   *
   * Effects:
   * - fetchState: GET /state → update ws.lastState → emit buildPostFetchEvent.
   *   Usage is on GET /state, not on the event (spike §4 correction).
   * - reseed: GET /history + GET /state → full re-broadcast (Chunk 4; for now
   *   just refresh the state and emit sessionUpdated).
   * - refetchQueue: GET /turn/input → emit queueUpdated with the full queue.
   */
  function foldEvent(ws: WarmSession, envelope: SseEnvelope): void {
    const ev = envelope.event;
    const ctx = makeCtx(ws, envelope.emitted_at ?? now());

    const { events: pilotEvents, effects } = mapDaemonEvent(
      ev,
      ws.acc,
      ctx,
    );

    // Emit the pure events first (deterministic, no I/O).
    for (const e of pilotEvents) emit(e);

    // Then execute the effect descriptors (I/O — order matters for fetchState
    // since buildPostFetchEvent reads the refreshed cache).
    for (const effect of effects) {
      executeEffect(ws, effect, ctx);
    }
  }

  /** Build a MapCtx for a warm session — the single place ctx is constructed.
   *  Used by both foldEvent (for SSE events) and executeEffect (for post-fetch
   *  follow-up events, which must read the refreshed lastState cache). */
  function makeCtx(ws: WarmSession, ts: string) {
    return {
      ref: ws.ref,
      workspace: workspaceFor(ws),
      now: () => ts,
      snapshot: (status: "idle" | "running" | "initializing" | "failed") =>
        snapshotFromState(ws.lastState, ws.ref, workspaceFor(ws), status, ts),
      liveStatus: () => statusFromState(ws.lastState),
    };
  }

  /** Execute a side-effect descriptor returned by the mapper. */
  function executeEffect(
    ws: WarmSession,
    effect:
      | { type: "fetchState"; emit: "runCompleted" | "sessionUpdated" }
      | { type: "reseed" }
      | { type: "refetchQueue" },
    ctx: ReturnType<typeof makeCtx>,
  ): void {
    switch (effect.type) {
      case "fetchState": {
        // Refresh the cached state, then build the follow-up event from the
        // refreshed cache (buildPostFetchEvent is pure + tested).
        void ws.client.state().then(({ data }) => {
          if (!data) return;
          ws.lastState = data;
          emit(buildPostFetchEvent(effect.emit, ctx));
        });
        break;
      }
      case "reseed": {
        // Chunk 4 will do the full GET /history re-broadcast. For now, refresh
        // the state cache and emit sessionUpdated so the UI reflects the change.
        // Reset the accumulator first: a reseed means stream state was lost
        // (stream_discontinuity) or history was truncated (session_rewound /
        // context_cleared), so any in-flight block or stale turnError is invalid.
        resetAccumulator(ws.acc);
        void ws.client.state().then(({ data }) => {
          if (!data) return;
          ws.lastState = data;
          emit(buildPostFetchEvent("sessionUpdated", ctx));
        });
        break;
      }
      case "refetchQueue": {
        // The queue events carry one item + revision, not the full queue. pilot's
        // queueUpdated REPLACES the full queue, so we must fetch GET /turn/input.
        // NOTE: PendingTurnInputItem carries no timestamp (only id + content), so
        // createdAt/updatedAt are set to fetch-time, not queue-time. This means
        // time-based sort is fetch-order, not queue-order — acceptable for v1 since
        // items[] order is queue order and the queue is display-only.
        void ws.client.turnInputSnapshot().then(({ data }) => {
          if (!data) return;
          emit({
            sessionRef: ws.ref,
            timestamp: now(),
            type: "queueUpdated",
            messages: data.items.map((item) => ({
              id: item.id,
              mode: "steer" as const, // daemon doesn't distinguish steer/followUp (spike §3)
              text: item.content,
              createdAt: now(),
              updatedAt: now(),
            })),
          });
        });
        break;
      }
    }
  }

  /** Spawn a daemon, claim the lease, subscribe to SSE, and warm it into the pool. */
  async function warmSession(
    cwd: string,
    sessionId?: string,
  ): Promise<WarmSession> {
    const spawned = await spawnDaemon(polytokenBin, { cwd, sessionId });
    const client = new DaemonClient(spawned.sessionId, spawned.port, process.pid);

    // Wait for the daemon to be ready (health check), then claim the lease.
    // The daemon may take a moment to bind its port after `new --no-attach` returns.
    try {
      await waitForHealth(client);
      await client.claimLease("pilot");
    } catch (e) {
      // Lease claim failed (e.g. 409 stale lease from a prior crash) or the daemon
      // didn't become healthy. Terminate the spawned daemon to avoid a leak.
      await client.close().catch(() => {});
      throw e;
    }

    // Seed the state cache so ctx.snapshot() works on the very first event.
    const { data: initialState } = await client.state();

    const ref = {
      workspaceId: cwd,
      sessionId: spawned.sessionId,
    };
    const ws: WarmSession = {
      client,
      ref,
      cwd,
      unsub: null,
      acc: createAccumulator(),
      lastState: initialState ?? null,
    };

    // Subscribe to the SSE stream and fold every frame.
    ws.unsub = client.subscribe((envelope) => foldEvent(ws, envelope));

    warm.set(spawned.sessionId, ws);
    activeSessionId = spawned.sessionId;
    return ws;
  }

  /** Active warm session, or null. */
  function active(): WarmSession | null {
    if (!activeSessionId) return null;
    return warm.get(activeSessionId) ?? null;
  }

  /** Tear down a warm session (release lease, terminate daemon, unsubscribe SSE). */
  async function disposeSession(ws: WarmSession): Promise<void> {
    ws.unsub?.();
    ws.unsub = null;
    await ws.client.close();
    // Remove from the pool (by sessionId).
    for (const [id, entry] of warm) {
      if (entry === ws) {
        warm.delete(id);
        if (activeSessionId === id) activeSessionId = null;
      }
    }
  }

  // Build the driver object. Optional methods are omitted for now (Chunk 1 scope) —
  // the hub guards with `?.`. Only the core happy-path methods are implemented.
  const driver: PilotDriver = {
    subscribe(listener: (ev: SessionDriverEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async prompt(
      text: string,
      _deliverAs?: "steer" | "followUp",
      sessionId?: string,
      _images?: readonly ImageContent[],
      promptId?: string,
    ): Promise<void> {
      const ws = sessionId ? warm.get(sessionId) ?? null : active();
      if (!ws) {
        throw new Error("no warm polytoken session to prompt");
      }
      // Echo the user's message into the transcript immediately (optimistic, like the
      // mock/pi drivers) so the client's row renders before the model streams.
      emit({
        sessionRef: ws.ref,
        timestamp: now(),
        type: "userMessage",
        id: promptId ?? `pt-${Date.now()}`,
        text,
      });
      // POST /prompt — the happy-path turn starter. Steering/follow-up (mid-turn)
      // would route to /turn/input, but deliverAs is pilot-side UX only (spike §3).
      await ws.client.prompt(text);
    },

    abort(sessionId?: SessionId): void {
      const ws = sessionId ? warm.get(sessionId) ?? null : active();
      if (!ws) return;
      void ws.client.cancelTurn();
    },

    respondUi(_response: HostUiResponse, _sessionId?: SessionId): void {
      // Chunk 3: interrogative/permission responses. The daemon client has the
      // respondInterrogative method; the HostUiRequest → interrogative mapping is
      // the host-UI bridge work.
    },

    async listSessions(): Promise<SessionListEntry[]> {
      // Chunk 4: read the sessions registry from --sessions-dir on disk.
      // For now, return only the warm session(s).
      const entries: SessionListEntry[] = [];
      for (const ws of warm.values()) {
        const { data } = await ws.client.state();
        entries.push({
          sessionId: ws.ref.sessionId,
          path: `polytoken://${ws.ref.sessionId}`,
          cwd: ws.cwd,
          displayName: data?.session_title ?? undefined,
          preview: "",
          userMessageCount: 0,
          updatedAt: now(),
          createdAt: now(),
          lastUserMessageAt: now(),
          archived: false,
        });
      }
      return entries;
    },

    async openSession(path: string): Promise<SessionDriverEvent[]> {
      // Chunk 4: spawn daemon --resume --session-id, seed from GET /history + GET /state.
      // For now, throw — the warm-session path (newSession) is the Chunk 1 happy path.
      throw new Error(`openSession not yet implemented (Chunk 4): ${path}`);
    },

    async newSession(opts: NewSessionOpts = {}): Promise<SessionDriverEvent[]> {
      const cwd = opts.cwd?.trim() || join(homedir(), "projects");
      // Warm the NEW session first, THEN dispose the old one on success — so a flaky
      // spawn doesn't lose the previously-working session (warm-then-dispose, not
      // dispose-then-warm). Chunk 4's warm pool will make this a non-issue.
      const old = active();
      const ws = await warmSession(cwd);
      if (old) await disposeSession(old).catch(() => {});
      const title = ws.lastState?.session_title ?? "New session";
      return [
        {
          sessionRef: ws.ref,
          timestamp: now(),
          type: "sessionOpened",
          snapshot: snapshotFromState(
            ws.lastState,
            ws.ref,
            workspaceFor(ws),
            statusFromState(ws.lastState),
            now(),
          ),
        },
      ];
    },

    defaultSeed(): SessionDriverEvent[] | null {
      // The pi driver returns the current warm session's seed; the mock returns its
      // greeting. For Chunk 1, a fresh-connecting client gets an empty landing until
      // a session is created — mirroring the real driver's boot (starts empty).
      return null;
    },

    async listModels(): Promise<ModelOption[]> {
      // Chunk 5: `polytoken models` lists configured models + reasoning variants.
      // For now, return an empty list — the model picker will be empty under this driver.
      return [];
    },

    async listCommands(_sessionId?: SessionId): Promise<CommandInfo[]> {
      // Chunk 5: `polytoken print-slash-commands` (JSON), cached per cwd.
      return [];
    },

    async listFileIndex(
      _sessionId?: SessionId,
    ): Promise<{ files: FileInfo[]; truncated: boolean }> {
      // Chunk 5: GET /files (daemon-native file index) — may replace pilot's fd.
      return { files: [], truncated: false };
    },

    async listFiles(
      _query: string,
      _sessionId?: SessionId,
      _cwd?: string,
    ): Promise<FileInfo[]> {
      return [];
    },

    async listDir(_path?: string): Promise<DirListing> {
      // New-session project picker browses the SERVER's filesystem — same as pi-driver.
      // Chunk 4 will wire this; for now return an empty listing.
      return { path: _path ?? homedir(), parent: null, entries: [], error: false };
    },

    async statPath(path: string): Promise<PathStat> {
      // Chunk 4: stat the disk for the new-session dir picker.
      return { path, exists: false, isDir: false };
    },

    setModel(_provider: string, _modelId: string, sessionId?: SessionId): void {
      const ws = sessionId ? warm.get(sessionId) ?? null : active();
      if (!ws) return;
      // Chunk 5: POST /model {model, reasoning_effort}. The model string is matched
      // against ModelConfig.name (the registry map key), not provider/modelId split.
      void ws.client.setModel(`${_provider}/${_modelId}`).catch((e) => {
        console.error("[polytoken] setModel failed", e);
      });
    },

    setThinking(level: string, sessionId?: SessionId): void {
      const ws = sessionId ? warm.get(sessionId) ?? null : active();
      if (!ws) return;
      // POST /model with reasoning_effort (the "thinking" lever). We need the current
      // model from state — setModel requires both model + reasoning_effort.
      void ws.client.state().then(({ data }) => {
        if (!data?.active_model) return;
        void ws.client.setModel(data.active_model, level).catch((e) => {
          console.error("[polytoken] setThinking failed", e);
        });
      });
    },
  };

  // --- Driver shutdown: tear down all warm daemons on process exit. ---
  // (The harness turn-hygiene lesson: own the lifecycle of every child — a daemon
  // process is a long-lived child. Clear it on shutdown so no zombie daemons remain.)
  // Three paths:
  // - SIGTERM/SIGINT (the common kill paths for `bun run dev`): run the async shutdown
  //   (HTTP /terminate + lease release), then exit.
  // - process.on("exit") (synchronous backstop): can't await HTTP round-trips, so
  //   hard-kill via killNow() (SIGTERM the daemon pid captured from /health).
  const shutdown = async () => {
    const all = [...warm.values()];
    warm.clear();
    await Promise.allSettled(all.map((ws) => disposeSession(ws)));
  };

  // Async shutdown for signals — awaits HTTP /terminate for a clean daemon drain.
  let shuttingDown = false;
  const handleSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[polytoken] received ${sig} — shutting down daemons`);
    void shutdown().then(() => process.exit(0));
    // Force-exit after 3s if daemons don't drain (don't hang the kill).
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));

  // Synchronous backstop for exit (covers normal return + signals that bypassed the
  // async handler). Can't await — hard-kill the daemon pids directly.
  process.on("exit", () => {
    for (const ws of warm.values()) {
      ws.client.killNow();
    }
  });

  return driver;
}

/** Poll GET /health until the daemon responds, with a timeout. The daemon takes a
 *  moment to bind its port after `new --no-attach` returns the port. */
async function waitForHealth(
  client: DaemonClient,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status } = await client.health();
    if (status === 200) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not become healthy within ${timeoutMs}ms`);
}
