// The pantoken WebSocket envelope. Wraps the vendored session-driver event stream
// with connection bootstrap (seed-on-connect + tail resume) and client commands.
//
// Events carry their own `sessionRef`. Client commands optionally carry a
// `sessionId` to target a specific session (D8 multi-session); omit it and the
// server applies the command to the currently-focused session.

import {
  sessionId,
  workspaceId,
  type BackgroundJob,
  type CommandInfo,
  type FileInfo,
  type HostUiRequest,
  type HostUiResponse,
  type ImageContent,
  type ModelCatalogDiagnostic,
  type ModelDefaults,
  type ModelOption,
  type PermissionMonitorMode,
  type SessionDriverEvent,
  type SessionId,
  type SessionListEntry,
} from "./session-driver.js";
// Bump on any breaking client↔server wire change so the hello handshake fails
// loud (client/src/lib/store.svelte.ts mismatch guard) instead of a stale bundle
// silently dropping unparseable messages. History: 1→2 = journal-first seed
// (2026-07-03); 2→3 = the nine settings/context ClientMessage variants collapsed
// into the single `sessionAction` envelope (a stale client's old-shape
// setModel/compact/… now fail serde on the server); 3→4 = correlated directory
// picker queries, preventing stale remote replies from replacing newer results;
// 4→5 = listBranches/branchList worktree branch selector; 5→6 = worktree support
// removed (worktree/baseBranch fields, listBranches/branchList/cleanupWorktree/
// worktreeRetained messages, WorktreeInfo).
export const PROTOCOL_VERSION = 6;

/** Pantoken-local settings (distinct from the daemon's global/session config). Persisted
 *  server-side in `pantoken-settings.json`, broadcast to every client, edited from the
 *  Settings panel. */
export interface PantokenSettings {
  /** Explicit login shell pantoken runs at startup to reconstruct your interactive
   *  environment (PATH, language-manager shims, exported vars) — the env a TUI tool
   *  inherits when launched from a terminal. `null` = use `$SHELL` / the OS login
   *  shell. A launchd daemon / GUI `.app` has no interactive-shell ancestor, so pantoken
   *  captures this once at boot; changing it applies on the NEXT server restart. */
  loginShell: string | null;
  /** Cheap "background model" spec for the tasks pantoken's own extensions run
   *  (session auto-naming, the answer tool's structured-extraction) — the model those
   *  out-of-band LLM calls use, separate from the session's primary model. Replaces
   *  the dotfiles `_lib/roles.mjs` per-role resolver.
   *
   *  Value: a daemon model spec `provider/model[:thinking]` (e.g.
   *  `anthropic/claude-haiku-4-5:low`), OR a `script:`-prefixed path whose stdout is
   *  such a spec (the escape hatch for an operator who wants their own resolver).
   *  `null` = unset; extensions fall back to a sensible default or no-op. The server
   *  resolves + validates this on read (see `resolveBackgroundModel`) and surfaces a
   *  loud `warning` to the Settings UI when the spec is bad — never silent. */
  backgroundModel: string | null;
}

/** Runtime status of pantoken's startup login-shell env capture, so the Settings panel
 *  can show what's ACTIVE now vs. what's configured (→ "restart to apply"). */
export interface LoginEnvStatus {
  /** Shell pantoken actually captured env from at startup, or null if capture was
   *  skipped (mock/dev) or never ran. */
  activeShell: string | null;
  /** Did the capture succeed? false → pantoken kept its minimal launch PATH. */
  ok: boolean;
  /** Human-readable outcome (var count, skip reason, or failure), for the panel. */
  detail?: string;
}

/** A directory's browsable contents for the new-session project picker. The server
 *  resolves `path` on ITS OWN filesystem (the agent runs server-side), so the picker browses
 *  the server, not whichever device the client runs on — a native browser file picker
 *  can't do that (it only sees the client device, and never yields a real path string).
 *  Files are omitted: you're choosing a working directory, so only child directories
 *  matter. The client sends {@link queryDir} and renders this as {@link dirListing}. */
export interface DirListing {
  /** Echoes the query request so clients can discard out-of-order remote replies. */
  readonly requestId: number;
  /** The resolved absolute directory actually listed. Echoes the request so a client
   *  that has since navigated elsewhere can drop a stale response. */
  readonly path: string;
  /** The parent directory, or null when `path` is the filesystem root. */
  readonly parent: string | null;
  /** Child directory basenames, sorted (non-hidden first). Tap one to descend. */
  readonly entries: readonly string[];
  /** True when `path` couldn't be read (missing / not a directory / no permission).
   *  `entries` is then empty and the client surfaces the failure instead of showing
   *  it as an empty folder. */
  readonly error?: boolean;
}

/** A quick existence-and-type check for a path the user typed into the new-session
 *  dir picker, so the client can show an inline hint before the full directory listing
 *  arrives. The client sends {@link statPath} (debounced) and renders the reply as a
 *  validation cue. */
export interface PathStat {
  /** Echoes the query request so clients can discard out-of-order remote replies. */
  readonly requestId: number;
  /** The resolved absolute path that was checked. Echoes the request. */
  readonly path: string;
  /** True when `path` exists on the server's filesystem. */
  readonly exists: boolean;
  /** True when `path` exists AND is a directory (implies `exists`). */
  readonly isDir: boolean;
}

/** Compact cross-session state for attention routing without broadcasting background
 * transcripts. `waiting` overrides the underlying run phase while dialogs are pending;
 * `done` remains useful until each client marks that session read locally. */
export interface SessionAttention {
  readonly sessionId: SessionId;
  readonly phase: "running" | "waiting" | "failed" | "done";
  readonly activity?: string;
  readonly pendingCount?: number;
  readonly pendingTitle?: string;
  readonly updatedAt: string;
}

export interface TrustRequestOption {
  readonly label: string;
  readonly trusted: boolean;
}

export interface TrustRequest {
  readonly requestId: string;
  readonly cwd: string;
  readonly title: string;
  readonly options: readonly TrustRequestOption[];
}

export type ServerMessage =
  | {
      type: "hello";
      protocolVersion: number;
      serverId: string;
      /** Human-readable identity of the machine whose filesystem this server exposes. */
      serverLabel: string;
      dataDir: string;
      /** Full commit sha of the client bundle the server is SERVING (from
       *  dist/.pantoken-built-sha). A running client compares it against its own
       *  baked sha to detect that the server updated underneath it — the SW is
       *  byte-identical across builds, so `updatefound` alone never fires.
       *  Empty/absent when no build marker exists (dev). */
      buildSha?: string;
    }
  /** Heartbeat reply to a client `ping` — transport-level only (never folded or
   *  journaled), the same shape of message as `hello`. The client's ws layer already
   *  treats ANY inbound frame as proof of liveness, so `pong` carries no fields of its
   *  own; it exists purely to give a sent ping something to solicit. */
  | { type: "pong" }
  /** Seed-on-connect (protocol v2): the focused session's full transcript as
   *  EVENTS, which the client folds from a fresh `initialSessionState()` — the
   *  replacement for v1's folded-state `snapshot`, so no server-side fold is
   *  client-visible. `epoch` names this transcript build (bumped on reset /
   *  reload / re-attach; a resume across a bump is impossible); `seq` is the
   *  stamp of the last event folded into the seed — the client's resume
   *  watermark. `sessionId` is null for the empty landing (nothing focused;
   *  `events` is then empty and the client just resets). */
  | {
      type: "seed";
      sessionId: SessionId | null;
      epoch: number;
      seq: number;
      events: readonly SessionDriverEvent[];
    }
  /** One incremental driver event to fold, stamped with the journal watermark
   *  it advanced the session to. The client folds it only when `epoch` matches
   *  its adopted seed and `seq` is contiguous — an epoch mismatch is a stale
   *  frame racing a reseed (drop it), a seq gap is a lost frame (request a
   *  fresh seed rather than fold a diverged stream). */
  | { type: "event"; event: SessionDriverEvent; epoch: number; seq: number }
  /** The sessions available to open + which one is active (server-authoritative).
   *  Kept separate from the per-session `seed`/`event` stream because it's
   *  cross-session meta-state, not the folded transcript of the active session. */
  | {
      type: "sessionList";
      sessions: readonly SessionListEntry[];
      activeSessionId: SessionId | null;
      /** The cwd a bare new session defaults to when the operator doesn't pick one
       *  ($HOME). The client uses it to open the boot landing draft and as the
       *  new-session placeholder. Surfaced here (cross-session meta, like
       *  activeSessionId) so the client doesn't have to guess the server's $HOME. */
      defaultNewSessionCwd: string;
    }
  /** Which sessions currently have a live turn, and which are still warming up (D8
   *  multi-session). Pushed whenever either set changes, so background rows can show a
   *  running / initializing / done indicator without the client folding their
   *  (un-broadcast) event streams. `initializingIds` is optional on the wire so an older
   *  client tolerates its absence; the hub always sends it. */
  | {
      type: "sessionStatus";
      runningIds: readonly SessionId[];
      initializingIds?: readonly SessionId[];
      /** Current cross-session attention summaries. Optional for older servers/clients. */
      attention?: readonly SessionAttention[];
    }
  /** The models available to switch to (server-authoritative, like `sessionList`).
   *  The current selection rides each session's snapshot `config`, not this. When
   *  discovery fails, `diagnostic` explains why the list is empty so the GUI can
   *  fail visibly instead of silently hiding the picker. */
  | {
      type: "modelList";
      models: readonly ModelOption[];
      diagnostic?: ModelCatalogDiagnostic;
    }
  /** The slash commands the focused session offers (extension/template/skill), for the
   *  composer's typeahead. Server-authoritative like `modelList`; re-broadcast on
   *  session switch because the set is cwd-scoped. See {@link CommandInfo}. */
  | { type: "commandList"; commands: readonly CommandInfo[] }
  /** The available facets for the focused session's cwd (for the FacetBadge picker).
   *  Pushed on connect + session switch like {@link commandList}. */
  | { type: "facetList"; facets: readonly string[] }
  /** Background jobs (subagent + shell) for the focused session. Broadcast on
   *  every snapshot refresh and on explicit {@link fetchJobs}. See
   *  {@link BackgroundJob}. */
  | { type: "jobsList"; jobs: readonly BackgroundJob[] }
  /** The full file index for the focused session's cwd, pushed on connect + session
   *  switch (like {@link commandList}). The client fuzzy-matches it locally so the
   *  @-mention menu is instant (no per-keystroke round-trip). Capped server-side;
   *  `truncated` is true when the cwd has more files than the cap, which is the only
   *  case the client falls back to a {@link queryFiles} search. See {@link FileInfo}. */
  | { type: "fileIndex"; files: readonly FileInfo[]; truncated: boolean }
  /** Skills + subagents available for the composer's `@skill:`/`@subagent:`
   *  reference autocomplete. Server-authoritative like {@link fileIndex}; pushed
   *  on connect and re-pushed on session switch (they're session/cwd-scoped). */
  | { type: "atRefs"; skills: readonly string[]; subagents: readonly string[] }
  /** File paths matching a composer @-mention query — the server-side `fd` *fallback*,
   *  used only when the {@link fileIndex} was truncated and local matches are thin (so a
   *  wanted file may live past the index cap). The client sends {@link queryFiles}
   *  (debounced); the `query` field echoes the request so stale responses are dropped.
   *  Merged into the local matches, deduped by path. See {@link FileInfo}.
   *
   *  `includeIgnored` echoes the request's flag (Shift+Tab picker toggle) — a second
   *  staleness guard alongside `query`: a toggled request must not be satisfied by a
   *  stale untoggled response (or vice versa) racing back after the toggle flipped. */
  | {
      type: "fileList";
      query: string;
      files: readonly FileInfo[];
      includeIgnored?: boolean;
    }
  /** A directory listing for the new-session project picker, in reply to {@link queryDir}.
   *  Carries the resolved `path` so a client that navigated on can drop a stale response.
   *  See {@link DirListing}. */
  | ({ type: "dirListing" } & DirListing)
  /** A path-existence check for the new-session dir picker's inline validation hint,
   *  in reply to {@link statPath}. Echoes the request `path` so the client can drop a
   *  stale response. See {@link PathStat}. */
  | ({ type: "pathStat" } & PathStat)
  /** the daemon's global model config: default model/thinking for new sessions + the
   *  favorites subset the header picker filters to. Distinct from a session's
   *  `config` (the CURRENT selection). See {@link ModelDefaults}. */
  | { type: "modelDefaults"; defaults: ModelDefaults }
  /** Pantoken-local settings + the live login-env capture status, for the Settings
   *  panel. Sent on connect and re-sent after `setLoginShell`/`setBackgroundModel`.
   *  `pendingRestart` is server-computed (the client can't resolve the server's default
   *  `$SHELL`): true when the shell pantoken WOULD use now differs from the one it actually
   *  captured with at boot — i.e. a restart is needed to apply the configured change.
   *  `backgroundModelWarning` is the server's resolution of `settings.backgroundModel`
   *  against the live model registry: present (non-empty) when the spec is bad or
   *  doesn't resolve — the Settings "Models" section surfaces it as a loud red error.
   *  Absent when the spec is unset or resolves cleanly. */
  | {
      type: "pantokenSettings";
      settings: PantokenSettings;
      env: LoginEnvStatus;
      pendingRestart: boolean;
      backgroundModelWarning?: string;
    }
  | {
      type: "trustRequest";
      requestId: string;
      cwd: string;
      title: string;
      options: readonly TrustRequestOption[];
    }
  | { type: "trustResolved"; requestId: string }
  /** Desktop auto-update status (driven by the desktop shell's updater loop via the
   *  /update/state endpoint). `available` true means a new app version was downloaded but
   *  deferred because a client is connected — clients show the sidebar update card; `sha`
   *  carries the version string. `applying` flips true after a client clicks "update now"
   *  (the shell then installs the bundle and relaunches). NOT the PWA service-worker
   *  update — that's the separate `swUpdateReady` "reload" toast. */
  | {
      type: "updateStatus";
      available: boolean;
      sha?: string;
      applying: boolean;
      /** Optional state detail; missing/unknown values are treated as deferred by clients. */
      status?: "deferred" | "rejected";
      reason?: "busy" | "failed";
      /** Optional desktop-shell state; additive and ignored by older clients. */
      desktopStale?: boolean;
    }
  /** Prefill the composer after a branch landed on a user prompt — navigateTree hands
   *  back that prompt's text for re-editing. Sent ONLY to the client that asked to
   *  branch (per-client composer state, never broadcast / folded into shared state). */
  | { type: "editorPrefill"; text: string }
  /** Acceptance result for a client-generated prompt id. `accepted` means the daemon's prompt
   *  preflight accepted/queued/handled it; later run failures still arrive normally. */
  | {
      type: "promptResult";
      promptId: string;
      accepted: boolean;
      sessionId?: SessionId;
      error?: string;
    }
  /** Text returned after atomically clearing the daemon's steering/follow-up queues. Sent only
   *  to the client that requested restore; the shared empty queue arrives as an event. */
  | {
      type: "queueRestored";
      steering: readonly string[];
      followUp: readonly string[];
    }
  /** Correlated outcome for one stop attempt. `accepted` means the daemon accepted
   *  the request; the transcript still has to receive a terminal event before the
   *  client may call the turn stopped. */
  | {
      type: "abortResult";
      requestId?: string;
      accepted: boolean;
      error?: string;
    }
  | {
      type: "error";
      message: string;
      kind?: "session-switch" | "abort" | "sessionAction" | "destroySession";
    };

/** Tail-resume request: "I still hold {sessionId} folded through {epoch, seq}".
 *  Carried on the reconnect hello; when the server's journal epoch matches and
 *  its ring still covers the gap, it replays only the missed stamped events
 *  instead of re-shipping the whole transcript — the cost that hurts on every
 *  phone wake over LTE. Any mismatch degrades to a full seed, never an error. */
export interface ResumeToken {
  readonly sessionId: SessionId;
  readonly epoch: number;
  readonly seq: number;
}

/** The fire-and-forget pass-through actions carried by the `sessionAction`
 *  ClientMessage. They share one lifecycle: POST to the daemon, no direct
 *  reply — the effect arrives via later driver events. Daemon endpoints:
 *  POST /adventurous-handoff (toggle), /notifications/autodrain, /compact,
 *  /clear (context + shell env), /mcp/{server}/{action}, /model, /thinking,
 *  /facet, /permission-monitor, /reset-shell, /reload, /goal (set/pause/resume/clear),
 *  /title. */
export type SessionAction =
  | { kind: "toggleAdventurousHandoff" }
  | { kind: "setNotificationAutodrain"; enabled: boolean }
  | { kind: "compact" }
  | { kind: "clearContext" }
  | {
      kind: "setMcpServer";
      serverName: string;
      action: "enable" | "disable" | "disconnect" | "reconnect";
    }
  | { kind: "setModel"; modelId: string; thinkingLevel?: string }
  | { kind: "setThinking"; level: string }
  | { kind: "setFacet"; facet: string }
  | { kind: "setPermissionMonitor"; mode: PermissionMonitorMode }
  | { kind: "resetShell" }
  | { kind: "daemonReload" }
  | { kind: "goalSet"; summary: string }
  | { kind: "goalPause" }
  | { kind: "goalResume" }
  | { kind: "goalClear" }
  | { kind: "setTitle"; title: string };

export type ClientMessage =
  | { type: "hello"; auth?: string; resume?: ResumeToken }
  | {
      type: "prompt";
      /** Stable client-generated id used for ACK/retry reconciliation and deduplication. */
      promptId?: string;
      text: string;
      images?: readonly ImageContent[];
      deliverAs?: "steer" | "followUp";
      sessionId?: SessionId;
    }
  | {
      type: "abort";
      /** Correlates this request with its `abortResult`, so a late response cannot
       *  overwrite the state of a retry or a subsequently-started turn. */
      requestId?: string;
      sessionId?: SessionId;
    }
  /** Clear every pending steering/follow-up message and restore their text to this
   *  client's editor (Pi parity: Alt+Up). */
  | { type: "restoreQueue"; sessionId?: SessionId }
  | { type: "respondUi"; response: HostUiResponse; sessionId?: SessionId }
  /** The data-driven envelope for fire-and-forget session actions that share one
   *  shape: a daemon POST whose effect arrives via later events (snapshots,
   *  notifications, usage updates) — no direct reply. Adding an action = one
   *  `SessionAction` variant + one arm per driver; the hub routes them all
   *  identically. Omit sessionId to target the focused session. */
  | { type: "sessionAction"; action: SessionAction; sessionId?: SessionId }
  /** Permanently reap an empty, default-settings session by its stable path. */
  | { type: "destroySession"; path: string }
  /** Set the explicit login shell pantoken captures env from at startup (null = the
   *  `$SHELL` / OS-login-shell default). Persists server-side; the env is captured
   *  once at boot, so it applies on the next server restart. The server re-broadcasts
   *  `pantokenSettings`. */
  | { type: "setLoginShell"; path: string | null }
  /** Set the background-model spec pantoken's own extensions run their cheap out-of-band
   *  LLM calls against (null = unset; extensions fall back). A `provider/model[:thinking]`
   *  spec OR a `script:`-prefixed path. Persists server-side; the server resolves +
   *  re-broadcasts `pantokenSettings` (carrying any validation `warning` for a bad spec). */
  | { type: "setBackgroundModel"; spec: string | null }
  /** Switch the active session to this .jsonl path. */
  | { type: "openSession"; path: string }
  /** Reload a session from scratch (by its .jsonl `path`): dispose the warm session
   *  (aborting any in-flight run) and re-warm it from disk, rebuilding the session's context anew —
   *  config, project trust, and extensions all loaded fresh. Restores the persisted
   *  transcript as closely as possible; in-memory-only state (an undelivered steer/followUp
   *  queue, an un-persisted branch jump) is lost. The recovery path for when an extension
   *  bug wedges a session: fix the extension elsewhere, then reload here to continue without
   *  restarting pantoken. The server re-seeds every client viewing the session. */
  | { type: "reloadSession"; path: string }
  /** Jump the session to a prior tree entry and branch from it (the daemon's /tree). `entryId`
   *  is a pantoken transcript item's `entryId` (a daemon tree node). The server calls
   *  navigateTree, then re-seeds every client's transcript to the new branch; if the
   *  target was a user prompt, the requester also gets an `editorPrefill` with its text.
   *  `summarize` asks the daemon to summarize the abandoned branch first (an LLM call) — the UI
   *  ships without it, but the flag is carried so the summarize path is additive later.
   *  Omit sessionId to target the focused session. */
  | {
      type: "branch";
      entryId: string;
      summarize?: boolean;
      sessionId?: SessionId;
    }
  /** Create a fresh session and make it active. `cwd` (an absolute dir, D12
   *  arbitrary GUI paths) picks the workspace; omit it for $HOME.
   *  `model`/`thinking`: apply this model + thinking level at creation, so the
   *  new-session draft's config carries through without mutating the daemon's global
   *  defaults. `prompt`: deliver this as the first message once the session is
   *  active — creation + first turn ride one message, so nothing is created on the
   *  server until the user actually sends (the draft lives client-side until then). */
  | {
      type: "newSession";
      cwd?: string;
      model?: { modelId: string };
      thinking?: string;
      /** Apply this facet at creation (draft-picked, e.g. start straight in plan). */
      facet?: string;
      /** Permission-monitor mode to apply at creation. Omitted/"standard" = daemon default. */
      permissionMonitor?: PermissionMonitorMode;
      prompt?: string;
      /** Id of the optional first prompt; deduplicates a retried create+send request. */
      promptId?: string;
      images?: readonly ImageContent[];
    }
  /** Ask the server to re-scan disk and re-broadcast the session list. */
  | { type: "listSessions" }
  /** Archive or unarchive a session (by its .jsonl `path`, the stable switch key).
   *  The flag is pantoken-side state (D-archive); the server persists it and re-broadcasts
   *  the session list so every client's active-only filter updates. */
  | { type: "setArchived"; path: string; archived: boolean }
  /** Rename a session (by its .jsonl `path`). Writes the daemon's session display name (a
   *  `session_info` entry); the server re-broadcasts the session list so every client's
   *  sidebar updates, and a warm session's header title updates live. Empty `name` is a
   *  no-op server-side (the client shouldn't submit one). */
  | { type: "renameSession"; path: string; name: string }
  /** Detach from a session: release Pantoken's TUI attachment lease so an external
   *  client (terminal polytoken CLI) can take over. The daemon stays alive; the
   *  session reappears as idle in the sidebar. Recovery for when Pantoken wedges. */
  | { type: "detachSession"; path: string }
  /** Ask the server to re-read the focused session's commands and re-broadcast them. */
  | { type: "listCommands" }
  /** Ask the server to re-read the focused session's available facets and
   *  re-broadcast them (reload affordance for the FacetBadge picker). */
  | { type: "listFacets" }
  /** Ask the server to re-fetch the daemon's background jobs list and
   *  re-broadcast it (reload affordance for the RightSidebar jobs section). */
  | { type: "fetchJobs" }
  /** Delete a todo by its integer ID. The daemon returns 409 if other todos
   *  depend on it or a turn is in flight; the server surfaces that as an error. */
  | { type: "deleteTodo"; id: number }
  /** Fallback file search for a composer @-mention query (the text after `@`). Only sent
   *  when the {@link fileIndex} was truncated and local matches are thin — the common case
   *  is served entirely client-side from the index. The server responds with {@link fileList}.
   *  Debounce client-side (~150ms); the server echoes the query back so stale responses
   *  can be dropped. `cwd` overrides the search root: a new-session draft has no session yet,
   *  so its @-mentions must search the soon-to-be project dir, not the previously focused
   *  session's cwd (which the pushed index reflects). Omitted -> the focused session's cwd.
   *
   *  `includeIgnored`: the picker's Shift+Tab toggle — when true, hidden dotfiles and
   *  gitignored entries are included too (project AND external browsing), bypassing the
   *  normal ignore-file filtering. Omitted/false is the default (filtered) behavior. */
  | {
      type: "queryFiles";
      query: string;
      cwd?: string;
      includeIgnored?: boolean;
    }
  /** Browse a directory on the SERVER's filesystem for the new-session project picker.
   *  `path` omitted/empty -> the server's $HOME; `~`/relative segments are resolved
   *  server-side. The server responds with {@link dirListing}. */
  | { type: "queryDir"; path?: string; requestId: number }
  /** Check whether a typed path exists on the server — a quick stat for the new-session
   *  dir picker's inline validation hint (debounced). The server responds with
   *  {@link pathStat}. */
  | { type: "statPath"; path: string; requestId: number }
  /** Apply the staged desktop update now (the sidebar card's button). The server marks
   *  it applying and the shell's updater picks it up on its next /update/state poll —
   *  install the bundle, relaunch. No-op if nothing is staged. */
  | { type: "applyUpdate" }
  /** Force an update check *now* (the build-stamp right-click menu), for clicking right
   *  after publishing a release — before the updater's next periodic check has noticed.
   *  Unlike `applyUpdate` it's NOT a no-op when nothing is staged: it flags a force the
   *  shell reads on its next poll, then immediately checks and applies if a new version
   *  exists. No-op only if the app is already current. */
  | { type: "forceUpdate" }
  /** Client-detected desync (an event-seq gap): ask for a fresh seed of the
   *  targeted session (omitted -> this connection's focus) instead of folding
   *  a diverged stream. */
  | {
      type: "trustResponse";
      requestId: string;
      choice: number | null;
    }
  | { type: "requestSeed"; sessionId?: SessionId }
  /** Dev-only: drive the mock fixture to a named scripted state. */
  | { type: "mock"; script: string }
  /** Reveal the server's data directory in the platform file manager (Finder on macOS).
   *  The client can't spawn processes, so this is a server-side action. The server
   *  best-efforts the spawn; a failure surfaces as an `error` message (e.g. on a
   *  headless/remote host with no GUI). The path itself is already known to the client
   *  via `hello.dataDir`, so copying it is local and needs no round-trip. */
  | { type: "openDataDir" }
  /** Heartbeat probe: sent on an interval while connected (and once immediately on a
   *  wake — tab foregrounded, bfcache restore, network back online) to catch a
   *  half-open socket that TCP itself may never surface (phone slept, NAT dropped the
   *  stream, no FIN/RST ever arrives). The server replies with `pong`; the client
   *  actually treats ANY inbound frame as liveness, so this mostly exists to solicit
   *  one on a schedule. */
  | { type: "ping" };

type JsonObject = Record<string, unknown>;
type Validator = (value: unknown) => boolean;
type ObjectValidator = (value: JsonObject) => boolean;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}
function has(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function string(value: unknown): value is string {
  return typeof value === "string";
}
function boolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
// JSON numbers must remain exactly representable on both the JS and Rust sides.
// Rust ingress accepts i64/u64 values; the client additionally rejects values
// outside Number's safe integer range so it cannot silently round a wire ID.
const MAX_SAFE_WIRE_INTEGER = Number.MAX_SAFE_INTEGER;
function integer(value: unknown): value is number {
  return number(value) && Number.isInteger(value) && Math.abs(value) <= MAX_SAFE_WIRE_INTEGER;
}
function unsignedInteger(value: unknown): value is number {
  return integer(value) && value >= 0;
}
function optional(value: JsonObject, key: string, validator: Validator): boolean {
  return !has(value, key) || validator(value[key]);
}
function nullable(value: unknown, validator: Validator): boolean {
  return value === null || validator(value);
}
function arrayOf(value: unknown, validator: Validator): boolean {
  return Array.isArray(value) && value.every(validator);
}
function required(value: JsonObject, key: string, validator: Validator): boolean {
  return has(value, key) && validator(value[key]);
}
function oneOf<T extends string>(...values: readonly T[]): Validator {
  return (value): value is T => string(value) && values.includes(value as T);
}

function sessionRef(value: unknown): boolean {
  const v = object(value);
  if (!v || !string(v.workspaceId) || !string(v.sessionId)) return false;
  v.workspaceId = workspaceId(v.workspaceId);
  v.sessionId = sessionId(v.sessionId);
  return true;
}
function image(value: unknown): boolean {
  const v = object(value);
  return !!v && v.type === "image" && required(v, "data", string) && required(v, "mimeType", string);
}
function resolvedRef(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "kind", string) && required(v, "name", string) && optional(v, "fileKind", string);
}
function queuedMessage(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "id", string) && required(v, "mode", oneOf("steer", "followUp")) &&
    required(v, "text", string) && required(v, "createdAt", string) && required(v, "updatedAt", string) &&
    optional(v, "references", (x) => arrayOf(x, resolvedRef));
}
function sessionConfig(value: unknown): boolean {
  const v = object(value);
  return !!v && optional(v, "modelId", string) && optional(v, "thinkingLevel", string) &&
    optional(v, "availableThinkingLevels", (x) => arrayOf(x, string));
}
function usage(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "tokens", (x) => x === null || integer(x)) && required(v, "contextWindow", integer) &&
    required(v, "percent", (x) => x === null || number(x));
}
function mcpInfo(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "serverName", string) && required(v, "status", oneOf("connected", "disconnected", "reconnecting", "disabled")) &&
    required(v, "toolCount", number);
}
function diagnostic(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "kind", oneOf("couldNotBeParsed", "emptyOutput", "noResponse")) && required(v, "message", string);
}
function modelOption(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "modelId", string) && required(v, "label", string) &&
    optional(v, "thinkingLevels", (x) => arrayOf(x, string)) && optional(v, "defaultThinkingLevel", string);
}
function commandInfo(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "name", string) && required(v, "source", oneOf("extension", "prompt", "skill", "builtin")) &&
    optional(v, "description", string) && optional(v, "argumentHint", string);
}
function fileInfo(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "path", string) && required(v, "isDirectory", boolean);
}
function modelDefaults(value: unknown): boolean {
  const v = object(value);
  return !!v && optional(v, "modelId", string) && optional(v, "thinkingLevel", string) &&
    required(v, "favorites", (x) => arrayOf(x, string)) &&
    optional(v, "defaultPermissionMonitor", oneOf("standard", "bypass", "bypass_plus", "autonomous"));
}
function goal(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "summary", string) && required(v, "lifecycle", string);
}
function flaggedFile(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "path", string) && required(v, "mode", oneOf("included", "referenced"));
}
function todo(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "id", integer) && required(v, "title", string) && required(v, "description", string) &&
    required(v, "status", oneOf("pending", "in_progress", "done", "blocked")) &&
    required(v, "dependencies", (x) => arrayOf(x, integer)) && optional(v, "createdAt", string);
}
function sessionAttention(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "sessionId", string) && required(v, "phase", oneOf("running", "waiting", "failed", "done")) && optional(v, "activity", string) && optional(v, "pendingCount", integer) && optional(v, "pendingTitle", string) && required(v, "updatedAt", string);
}
function backgroundJob(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "handle", string) && required(v, "kind", oneOf("shell", "subagent")) &&
    required(v, "status", oneOf("reserved", "running", "completed", "failed", "cancelled")) &&
    required(v, "toolName", string) && required(v, "createdAt", string) && required(v, "updatedAt", string) &&
    optional(v, "endedAt", string) && optional(v, "startedAt", string) && optional(v, "subagentType", string) &&
    optional(v, "model", string) && optional(v, "subagentHandle", string) && optional(v, "expiring", boolean) &&
    optional(v, "outputTail", string) && optional(v, "outputBytes", number);
}
function workspace(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "workspaceId", string) && required(v, "path", string) && optional(v, "displayName", string);
}
function snapshot(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "ref", sessionRef) && required(v, "workspace", workspace) && required(v, "title", string) &&
    required(v, "status", oneOf("idle", "initializing", "running", "failed")) && required(v, "updatedAt", string) &&
    optional(v, "archivedAt", string) && optional(v, "preview", string) && optional(v, "config", sessionConfig) &&
    optional(v, "usage", usage) && optional(v, "runningRunId", string) && optional(v, "queuedMessages", (x) => arrayOf(x, queuedMessage)) &&
    optional(v, "facet", string) && optional(v, "permissionMonitor", oneOf("standard", "bypass", "bypass_plus", "autonomous")) &&
    optional(v, "adventurousHandoff", boolean) && optional(v, "notificationAutodrain", boolean) && optional(v, "activePlan", string) &&
    optional(v, "goal", (x) => nullable(x, goal)) && optional(v, "flags", (x) => arrayOf(x, flaggedFile)) &&
    optional(v, "todos", (x) => arrayOf(x, todo)) && optional(v, "mcpServers", (x) => arrayOf(x, mcpInfo)) &&
    optional(v, "cwd", string) && optional(v, "cwdStackDepth", number);
}
function sessionListEntry(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "sessionId", string) && required(v, "path", string) && required(v, "cwd", string) &&
    optional(v, "displayName", string) && required(v, "preview", string) && required(v, "userMessageCount", number) &&
    required(v, "updatedAt", string) && required(v, "createdAt", string) && required(v, "lastUserMessageAt", string) &&
    optional(v, "parentSessionPath", string) && optional(v, "usage", usage) && required(v, "archived", boolean) &&
    optional(v, "lifecycle", oneOf("emptyDefault", "acceptedPrompt", "liveConfigAction", "unknown"));
}
function qnaAnswer(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "selectedOptionIndices", (x) => arrayOf(x, integer)) && required(v, "customText", string);
}
function qnaQuestion(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "question", string) && optional(v, "context", string) &&
    optional(v, "options", (x) => arrayOf(x, (y) => {
      const o = object(y);
      return !!o && required(o, "label", string) && optional(o, "description", string);
    })) && optional(v, "multiSelect", boolean);
}
function hostResponse(value: unknown): boolean {
  const v = object(value);
  if (!v || !required(v, "requestId", string)) return false;
  if (has(v, "value")) return string(v.value) && optional(v, "feedback", string);
  if (has(v, "confirmed")) return boolean(v.confirmed);
  if (has(v, "answers")) return arrayOf(v.answers, qnaAnswer);
  return v.cancelled === true;
}
const hostRequestValidators = {
  confirm: (v: JsonObject) => required(v, "title", string) && required(v, "message", string) && optional(v, "defaultValue", boolean) && optional(v, "timeoutMs", number),
  input: (v: JsonObject) => required(v, "title", string) && optional(v, "placeholder", string) && optional(v, "initialValue", string) && optional(v, "timeoutMs", number),
  select: (v: JsonObject) => required(v, "title", string) && required(v, "options", (x) => arrayOf(x, string)) && optional(v, "allowMultiple", boolean) && optional(v, "timeoutMs", number),
  editor: (v: JsonObject) => required(v, "title", string) && optional(v, "initialValue", string),
  qna: (v: JsonObject) => optional(v, "title", string) && required(v, "questions", (x) => arrayOf(x, qnaQuestion)) && optional(v, "timeoutMs", number),
  plan: (v: JsonObject) => required(v, "title", string) && required(v, "planText", string) && optional(v, "displayPath", string) && optional(v, "targetFacet", string) && required(v, "actionLabels", (x) => Array.isArray(x) && x.length === 3 && x.every(string)) && optional(v, "refuseLabel", string) && optional(v, "timeoutMs", number),
  permission: (v: JsonObject) => required(v, "title", string) && required(v, "toolName", (x) => x === null || string(x)) && required(v, "toolInput", (x) => x === null || string(x)) && required(v, "options", (x) => arrayOf(x, string)) && optional(v, "timeoutMs", number),
  unknown: (v: JsonObject) => required(v, "title", string) && required(v, "message", string),
  notify: (v: JsonObject) => required(v, "message", string) && optional(v, "level", oneOf("info", "warning", "error")),
  status: (v: JsonObject) => required(v, "key", string) && optional(v, "text", string),
  widget: (v: JsonObject) => required(v, "key", string) && optional(v, "lines", (x) => arrayOf(x, string)) && optional(v, "placement", oneOf("aboveComposer", "belowComposer")),
  title: (v: JsonObject) => required(v, "title", string),
  editorText: (v: JsonObject) => required(v, "text", string),
  reset: (_v: JsonObject) => true,
} satisfies Record<HostUiRequest["kind"], ObjectValidator>;

function validatorFor<T extends string>(table: Record<T, ObjectValidator>, key: unknown): ObjectValidator | undefined {
  return string(key) && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key as T]
    : undefined;
}
function hostRequest(value: unknown): boolean {
  const v = object(value);
  if (!v || !required(v, "kind", string) || !required(v, "requestId", string)) return false;
  const validator = validatorFor(hostRequestValidators, v.kind);
  return validator ? validator(v) : false;
}
const sessionEventValidators = {
  sessionOpened: (v: JsonObject) => required(v, "snapshot", snapshot),
  sessionUpdated: (v: JsonObject) => required(v, "snapshot", snapshot),
  assistantDelta: (v: JsonObject) => required(v, "text", string) && optional(v, "channel", oneOf("text", "thinking")) && optional(v, "entryId", string),
  queuedMessageStarted: (v: JsonObject) => required(v, "message", queuedMessage),
  queueUpdated: (v: JsonObject) => required(v, "messages", (x) => arrayOf(x, queuedMessage)),
  userMessage: (v: JsonObject) => required(v, "id", string) && required(v, "text", string) && optional(v, "images", (x) => arrayOf(x, image)) && optional(v, "entryId", string) && optional(v, "references", (x) => arrayOf(x, resolvedRef)),
  customMessage: (v: JsonObject) => required(v, "id", string) && required(v, "customType", string) && required(v, "text", string) && required(v, "display", boolean) && optional(v, "turnBoundary", boolean),
  toolStarted: (v: JsonObject) => required(v, "toolName", string) && required(v, "callId", string) && optional(v, "label", string) && optional(v, "description", string),
  toolUpdated: (v: JsonObject) => required(v, "callId", string) && optional(v, "text", string) && optional(v, "progress", number),
  toolFinished: (v: JsonObject) => required(v, "callId", string) && required(v, "success", boolean) && optional(v, "images", (x) => arrayOf(x, image)) && optional(v, "interrupted", boolean),
  runCompleted: (v: JsonObject) => required(v, "snapshot", snapshot) && optional(v, "userEntryId", string) && optional(v, "assistantEntryId", string),
  usageUpdated: (v: JsonObject) => required(v, "usage", usage),
  runFailed: (v: JsonObject) => { const e = object(v.error); return !!e && required(e, "message", string) && optional(e, "code", string); },
  hostUiRequest: (v: JsonObject) => required(v, "request", hostRequest),
  hostUiResolved: (v: JsonObject) => required(v, "requestId", string),
  extensionCompatibilityIssue: (v: JsonObject) => { const i = object(v.issue); return !!i && required(i, "capability", string) && required(i, "classification", oneOf("terminal-only")) && required(i, "message", string) && optional(i, "extensionPath", string) && optional(i, "eventName", string); },
  sessionClosed: (v: JsonObject) => required(v, "reason", oneOf("manual", "ended", "failed")),
  sessionReset: (_v: JsonObject) => true,
  nestedReplayStatus: (v: JsonObject) => required(v, "subagentHandle", string) && required(v, "status", oneOf("loading", "available", "unavailable")) && optional(v, "reason", string),
} satisfies Record<SessionDriverEvent["type"], ObjectValidator>;

function sessionEvent(value: unknown): boolean {
  const v = object(value);
  if (!v || !required(v, "type", string) || !required(v, "sessionRef", sessionRef) || !required(v, "timestamp", string) ||
    !optional(v, "runId", string) || !optional(v, "subagentHandle", string)) return false;
  const validator = validatorFor(sessionEventValidators, v.type);
  return validator ? validator(v) : false;
}
function resume(value: unknown): boolean {
  const v = object(value);
  return !!v && required(v, "sessionId", string) && required(v, "epoch", unsignedInteger) && required(v, "seq", unsignedInteger);
}
const actionValidators = {
  toggleAdventurousHandoff: (_v: JsonObject) => true,
  setNotificationAutodrain: (v: JsonObject) => required(v, "enabled", boolean),
  compact: (_v: JsonObject) => true,
  clearContext: (_v: JsonObject) => true,
  setMcpServer: (v: JsonObject) => required(v, "serverName", string) && required(v, "action", oneOf("enable", "disable", "disconnect", "reconnect")),
  setModel: (v: JsonObject) => required(v, "modelId", string) && optional(v, "thinkingLevel", string),
  setThinking: (v: JsonObject) => required(v, "level", string),
  setFacet: (v: JsonObject) => required(v, "facet", string),
  setPermissionMonitor: (v: JsonObject) => required(v, "mode", oneOf("standard", "bypass", "bypass_plus", "autonomous")),
  resetShell: (_v: JsonObject) => true,
  daemonReload: (_v: JsonObject) => true,
  goalSet: (v: JsonObject) => required(v, "summary", string),
  goalPause: (_v: JsonObject) => true,
  goalResume: (_v: JsonObject) => true,
  goalClear: (_v: JsonObject) => true,
  setTitle: (v: JsonObject) => required(v, "title", string),
} satisfies Record<SessionAction["kind"], ObjectValidator>;

function action(value: unknown): boolean {
  const v = object(value);
  if (!v || !required(v, "kind", string)) return false;
  const validator = validatorFor(actionValidators, v.kind);
  return validator ? validator(v) : false;
}
function normalizeIds(value: JsonObject): void {
  if (string(value.sessionId)) value.sessionId = sessionId(value.sessionId);
  if (string(value.activeSessionId)) value.activeSessionId = sessionId(value.activeSessionId);
  if (Array.isArray(value.runningIds)) value.runningIds = value.runningIds.map((x) => sessionId(x as string));
  if (Array.isArray(value.initializingIds)) value.initializingIds = value.initializingIds.map((x) => sessionId(x as string));
  if (Array.isArray(value.sessions)) for (const entry of value.sessions) {
    const e = object(entry);
    if (e && string(e.sessionId)) e.sessionId = sessionId(e.sessionId);
  }
  if (Array.isArray(value.attention)) for (const entry of value.attention) {
    const e = object(entry);
    if (e && string(e.sessionId)) e.sessionId = sessionId(e.sessionId);
  }
  if (object(value.resume)) {
    const r = object(value.resume);
    if (r && string(r.sessionId)) r.sessionId = sessionId(r.sessionId);
  }
  if (object(value.event)) normalizeEventIds(object(value.event));
  if (Array.isArray(value.events)) for (const event of value.events) normalizeEventIds(object(event));
}
function normalizeEventIds(value: JsonObject | null): void {
  if (!value) return;
  const ref = object(value.sessionRef);
  if (ref && string(ref.workspaceId) && string(ref.sessionId)) {
    ref.workspaceId = workspaceId(ref.workspaceId);
    ref.sessionId = sessionId(ref.sessionId);
  }
  if (object(value.snapshot)) {
    const s = object(value.snapshot);
    const r = s && object(s.ref);
    if (r && string(r.workspaceId) && string(r.sessionId)) {
      r.workspaceId = workspaceId(r.workspaceId);
      r.sessionId = sessionId(r.sessionId);
    }
    const workspace = s && object(s.workspace);
    if (workspace && string(workspace.workspaceId)) {
      workspace.workspaceId = workspaceId(workspace.workspaceId);
    }
  }
}
const noFields: Validator = (_value) => true;
const nullableString: Validator = (value) => value === null || string(value);

const clientMessageValidators = {
  hello: (v: JsonObject) => optional(v, "auth", string) && optional(v, "resume", resume),
  prompt: (v: JsonObject) => required(v, "text", string) && optional(v, "promptId", string) && optional(v, "images", (x) => arrayOf(x, image)) && optional(v, "deliverAs", oneOf("steer", "followUp")) && optional(v, "sessionId", string),
  abort: (v: JsonObject) => optional(v, "requestId", string) && optional(v, "sessionId", string),
  restoreQueue: (v: JsonObject) => optional(v, "sessionId", string),
  respondUi: (v: JsonObject) => required(v, "response", hostResponse) && optional(v, "sessionId", string),
  sessionAction: (v: JsonObject) => required(v, "action", action) && optional(v, "sessionId", string),
  destroySession: (v: JsonObject) => required(v, "path", string),
  setLoginShell: (v: JsonObject) => required(v, "path", nullableString),
  setBackgroundModel: (v: JsonObject) => required(v, "spec", nullableString),
  openSession: (v: JsonObject) => required(v, "path", string),
  reloadSession: (v: JsonObject) => required(v, "path", string),
  branch: (v: JsonObject) => required(v, "entryId", string) && optional(v, "summarize", boolean) && optional(v, "sessionId", string),
  newSession: (v: JsonObject) => optional(v, "cwd", string) && optional(v, "model", (x) => { const m = object(x); return !!m && required(m, "modelId", string); }) && optional(v, "thinking", string) && optional(v, "facet", string) && optional(v, "permissionMonitor", oneOf("standard", "bypass", "bypass_plus", "autonomous")) && optional(v, "prompt", string) && optional(v, "promptId", string) && optional(v, "images", (x) => arrayOf(x, image)),
  listSessions: noFields,
  setArchived: (v: JsonObject) => required(v, "path", string) && required(v, "archived", boolean),
  renameSession: (v: JsonObject) => required(v, "path", string) && required(v, "name", string),
  detachSession: (v: JsonObject) => required(v, "path", string),
  listCommands: noFields,
  listFacets: noFields,
  fetchJobs: noFields,
  deleteTodo: (v: JsonObject) => required(v, "id", integer),
  queryFiles: (v: JsonObject) => required(v, "query", string) && optional(v, "cwd", string) && optional(v, "includeIgnored", boolean),
  queryDir: (v: JsonObject) => required(v, "requestId", unsignedInteger) && optional(v, "path", string),
  statPath: (v: JsonObject) => required(v, "path", string) && required(v, "requestId", unsignedInteger),
  applyUpdate: noFields,
  forceUpdate: noFields,
  trustResponse: (v: JsonObject) => required(v, "requestId", string) && required(v, "choice", (x) => x === null || integer(x)),
  requestSeed: (v: JsonObject) => optional(v, "sessionId", string),
  mock: (v: JsonObject) => required(v, "script", string),
  openDataDir: noFields,
  ping: noFields,
} satisfies Record<ClientMessage["type"], ObjectValidator>;

function validClient(value: JsonObject): boolean {
  if (!string(value.type)) return false;
  if (!Object.prototype.hasOwnProperty.call(clientMessageValidators, value.type)) return false;
  const validator = clientMessageValidators[value.type as ClientMessage["type"]];
  return validator ? validator(value) : false;
}
const serverMessageValidators = {
  hello: (v: JsonObject) => {
    if (!required(v, "protocolVersion", unsignedInteger) || !required(v, "serverId", string) || !optional(v, "serverLabel", string) || !required(v, "dataDir", string) || !optional(v, "buildSha", string)) return false;
    if (!has(v, "serverLabel")) v.serverLabel = "";
    return true;
  },
  pong: noFields,
  seed: (v: JsonObject) => required(v, "sessionId", (x) => nullable(x, string)) && required(v, "epoch", unsignedInteger) && required(v, "seq", unsignedInteger) && required(v, "events", (x) => arrayOf(x, sessionEvent)),
  event: (v: JsonObject) => required(v, "event", sessionEvent) && required(v, "epoch", unsignedInteger) && required(v, "seq", unsignedInteger),
  sessionList: (v: JsonObject) => required(v, "sessions", (x) => arrayOf(x, sessionListEntry)) && required(v, "activeSessionId", (x) => nullable(x, string)) && required(v, "defaultNewSessionCwd", string),
  sessionStatus: (v: JsonObject) => required(v, "runningIds", (x) => arrayOf(x, string)) && optional(v, "initializingIds", (x) => arrayOf(x, string)) && optional(v, "attention", (x) => arrayOf(x, sessionAttention)),
  modelList: (v: JsonObject) => required(v, "models", (x) => arrayOf(x, modelOption)) && optional(v, "diagnostic", diagnostic),
  commandList: (v: JsonObject) => required(v, "commands", (x) => arrayOf(x, commandInfo)),
  facetList: (v: JsonObject) => required(v, "facets", (x) => arrayOf(x, string)),
  jobsList: (v: JsonObject) => required(v, "jobs", (x) => arrayOf(x, backgroundJob)),
  fileIndex: (v: JsonObject) => { if (!required(v, "files", (x) => arrayOf(x, fileInfo)) || !optional(v, "truncated", boolean)) return false; if (!has(v, "truncated")) v.truncated = false; return true; },
  fileList: (v: JsonObject) => required(v, "query", string) && required(v, "files", (x) => arrayOf(x, fileInfo)) && optional(v, "includeIgnored", boolean),
  atRefs: (v: JsonObject) => required(v, "skills", (x) => arrayOf(x, string)) && required(v, "subagents", (x) => arrayOf(x, string)),
  dirListing: (v: JsonObject) => required(v, "requestId", unsignedInteger) && required(v, "path", string) && required(v, "parent", (x) => nullable(x, string)) && required(v, "entries", (x) => arrayOf(x, string)) && optional(v, "error", boolean),
  pathStat: (v: JsonObject) => required(v, "requestId", unsignedInteger) && required(v, "path", string) && required(v, "exists", boolean) && required(v, "isDir", boolean),
  modelDefaults: (v: JsonObject) => required(v, "defaults", modelDefaults),
  pantokenSettings: (v: JsonObject) => { const s = object(v.settings); const e = object(v.env); return !!s && (required(s, "loginShell", nullableString) && required(s, "backgroundModel", nullableString) && optional(s, "enabledExtensions", (x) => x === null || arrayOf(x, string))) && !!e && required(e, "activeShell", nullableString) && required(e, "ok", boolean) && optional(e, "detail", string) && required(v, "pendingRestart", boolean) && optional(v, "backgroundModelWarning", string); },
  trustRequest: (v: JsonObject) => required(v, "requestId", string) && required(v, "cwd", string) && required(v, "title", string) && required(v, "options", (x) => arrayOf(x, (y) => { const o = object(y); return !!o && required(o, "label", string) && required(o, "trusted", boolean); })),
  trustResolved: (v: JsonObject) => required(v, "requestId", string),
  updateStatus: (v: JsonObject) => required(v, "available", boolean) && optional(v, "sha", string) && required(v, "applying", boolean) && optional(v, "status", oneOf("deferred", "rejected")) && optional(v, "reason", oneOf("busy", "failed")) && optional(v, "desktopStale", boolean),
  editorPrefill: (v: JsonObject) => required(v, "text", string),
  promptResult: (v: JsonObject) => required(v, "promptId", string) && required(v, "accepted", boolean) && optional(v, "sessionId", string) && optional(v, "error", string),
  queueRestored: (v: JsonObject) => required(v, "steering", (x) => arrayOf(x, string)) && required(v, "followUp", (x) => arrayOf(x, string)),
  abortResult: (v: JsonObject) => optional(v, "requestId", string) && required(v, "accepted", boolean) && optional(v, "error", string),
  error: (v: JsonObject) => required(v, "message", string) && optional(v, "kind", oneOf("session-switch", "abort", "sessionAction", "destroySession")),
} satisfies Record<ServerMessage["type"], ObjectValidator>;

function validServer(value: JsonObject): boolean {
  if (!string(value.type)) return false;
  if (!Object.prototype.hasOwnProperty.call(serverMessageValidators, value.type)) return false;
  const validator = serverMessageValidators[value.type as ServerMessage["type"]];
  return validator ? validator(value) : false;
}

/** Parse a raw WS frame, validating known fields and discriminants while ignoring unknown keys. */
function parseMessage<T extends { type: string }>(raw: string, validator: (value: JsonObject) => boolean): T | null {
  try {
    const value = object(JSON.parse(raw));
    if (!value || !validator(value)) return null;
    normalizeIds(value);
    return value as T;
  } catch {
    return null;
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  return parseMessage<ClientMessage>(raw, validClient);
}

export function parseServerMessage(raw: string): ServerMessage | null {
  return parseMessage<ServerMessage>(raw, validServer);
}
