#!/usr/bin/env bun
// update-watcher.ts — the brain of the desktop app's auto-update.
//
// Polls a *dedicated clone* (the one the desktop app runs from — NOT your dev tree)
// for new commits on origin/main and keeps it current without stomping live work:
//
//   • unattended & idle (no client connected, no turn running) → apply immediately
//                     (pull → install if the lock moved → build → ask the server to
//                     restart). Safe because there's no open UI to interrupt (not even
//                     a half-typed prompt) and no background agent turn to abort.
//   • anything else → defer. A connected client gets an `update-deferred` event (the
//                     desktop shell renders it as a sidebar update card with an
//                     "update now" button) + a native notification; a background turn
//                     with no viewer waits silently until it finishes. Deferred updates
//                     do NOT auto-apply on idle — they stay pending until the user
//                     clicks the card (explicit-apply wiring lands with the card UI).
//
// This mirrors the Mac Mini's scripts/auto-deploy.sh fetch+compare core, minus the
// blue-green/smoke/flip machinery — that exists only because the Mini is headless and
// unattended. The *session-aware defer* here is the policy worth sharing everywhere.
//
// Decoupling: this talks to the running server only over HTTP (/health) and asks it to
// restart by SIGTERM-ing the pid the server records in `dataDir/pilot.pid`. It does NOT
// respawn the server itself — that's the supervisor's job:
//   • desktop app → the Swift shell supervises (respawn server on exit, KeepAlive-style)
//   • Mac Mini    → launchd KeepAlive (today driven by auto-deploy.sh, not this watcher)
// Run standalone for testing with --dry-run (detect + decide + log, mutate nothing).
//
// Pure helpers (decideAction / lockfileChanged / isBusyFromHealth / shouldNotify) are
// exported and unit-tested in update-watcher.test.ts; the IO around them stays thin.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─────────────────────────────── config ───────────────────────────────

export interface WatcherConfig {
  /** The clone the desktop app runs from and this watches. A DEDICATED checkout that
   *  tracks origin/main cleanly — never your ~/src/pilot dev tree, or `git pull
   *  --ff-only` fights your uncommitted work. */
  clone: string;
  remote: string;
  branch: string;
  /** /health URL of the running server (carries `clients` + `busy`). */
  healthUrl: string;
  /** /update/state URL — we POST the staged-update state and learn back whether the
   *  user clicked "update now" (so the card's button is responsive). */
  updateUrl: string;
  /** App token, sent as Bearer to the gated /update/state endpoint. Empty/undefined on
   *  the local desktop app (auth off); set behind tailscale. */
  token?: string;
  /** Data dir holding `pilot.pid` (the server's recorded pid; our restart signal). */
  dataDir: string;
  /** How often to `git fetch` (the network-heavy check). */
  intervalMs: number;
  /** Loop cadence while an update is pending + a client is connected — keeps the card's
   *  "update now" responsive (we re-poll /update/state this often). Idle loops sleep the
   *  full fetch interval instead. */
  pollMs: number;
  /** Detect + decide + log, but mutate nothing (no pull/build/restart/notify/report). */
  dryRun: boolean;
  /** Fire an `osascript` notification on defer (macOS). The Swift shell sets this off
   *  (PILOT_UPDATE_NATIVE_NOTIFY=0) once it owns notifications; on by default so the
   *  watcher is useful standalone today. */
  nativeNotify: boolean;
}

/** XDG state dir, kept in sync with server/src/config.ts defaultDataDir() (inlined so
 *  this loose script stays self-contained and relocatable next to the Swift app). */
function defaultDataDir(): string {
  const stateHome =
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(stateHome, "pilot");
}

export function configFromEnv(
  argv: readonly string[] = process.argv,
): WatcherConfig {
  const port = process.env.PILOT_PORT ?? "8787";
  const base = process.env.PILOT_SERVER_URL ?? `http://127.0.0.1:${port}`;
  return {
    clone: process.env.PILOT_APP_CLONE ?? join(homedir(), "pilot-app"),
    remote: process.env.PILOT_UPDATE_REMOTE ?? "origin",
    branch: process.env.PILOT_UPDATE_BRANCH ?? "main",
    healthUrl: process.env.PILOT_HEALTH_URL ?? `${base}/health`,
    updateUrl: process.env.PILOT_UPDATE_URL ?? `${base}/update/state`,
    token: process.env.PILOT_TOKEN || undefined,
    dataDir: process.env.PILOT_DATA_DIR ?? defaultDataDir(),
    intervalMs: Number(process.env.PILOT_UPDATE_INTERVAL_MS ?? 60_000),
    pollMs: Number(process.env.PILOT_UPDATE_POLL_MS ?? 5_000),
    dryRun:
      process.env.PILOT_UPDATE_DRY_RUN === "1" || argv.includes("--dry-run"),
    nativeNotify: process.env.PILOT_UPDATE_NATIVE_NOTIFY !== "0",
  };
}

// ─────────────────────────── pure decision logic ───────────────────────────

export type Action = "apply" | "defer" | "noop";

/** The update policy in one place. `apply` only when it's safe to restart unattended:
 *  no client connected (no open UI to interrupt — not even a half-typed prompt) AND no
 *  turn in flight (don't abort a background agent run with nobody watching). Everything
 *  else → `defer`: surface the update card to a connected client, otherwise just wait.
 *  Deferred updates stay pending — they do NOT auto-apply when a turn goes idle; applying
 *  while a client is connected is the card button's job. To get the literal "auto-apply
 *  the moment nothing is running" instead, change the guard to `if (!o.busy) return
 *  "apply"`. */
export function decideAction(o: {
  behind: boolean;
  clientsConnected: boolean;
  busy: boolean;
}): Action {
  if (!o.behind) return "noop";
  if (!o.clientsConnected && !o.busy) return "apply";
  return "defer";
}

/** The served app is stale when the *built* bundle isn't origin/main. Comparing the built
 *  sha (vite stamps it into client/dist/.pilot-built-sha) rather than git HEAD is what lets
 *  the watcher self-heal a state where HEAD advanced but the bundle didn't: a manual `git
 *  pull`, an apply interrupted before its build, or a build that failed after the pull — all
 *  leave HEAD ahead of what's served, and a HEAD-vs-remote check would call that "up to
 *  date" forever. A null built sha (fresh clone, never stamped) counts as stale so the first
 *  tick builds and stamps it. */
export function isBuildStale(
  builtSha: string | null,
  remoteSha: string,
): boolean {
  return builtSha !== remoteSha;
}

/** /health and /update/state must hit the SAME server: behind-detection + the notification
 *  read /health, the update card is driven by POST /update/state. They derive from one base
 *  unless individually overridden, so a config that pins one URL but not the other (the bug
 *  that silently hid the card while notifications still fired) makes them disagree. Returns
 *  "<a> vs <b>" on mismatch for a loud startup warning, else null. */
export function originMismatch(
  healthUrl: string,
  updateUrl: string,
): string | null {
  try {
    const h = new URL(healthUrl).origin;
    const u = new URL(updateUrl).origin;
    return h === u ? null : `${h} vs ${u}`;
  } catch {
    return null; // unparseable URLs surface elsewhere; don't block startup on this check
  }
}

/** Did `bun.lock` change across the pull? Drives whether we reinstall. Treats
 *  appearance/disappearance (null↔string) as a change; both-absent as no change. */
export function lockfileChanged(
  before: string | null,
  after: string | null,
): boolean {
  return before !== after;
}

/** Extract "is a turn in flight?" from a /health body. Prefers the explicit `busy`
 *  flag; falls back to running+initializing counts for forward/backward tolerance;
 *  anything unrecognized → not busy (a missing signal must not block updates forever). */
export function isBusyFromHealth(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.busy === "boolean") return b.busy;
  const running = typeof b.running === "number" ? b.running : 0;
  const initializing = typeof b.initializing === "number" ? b.initializing : 0;
  return running + initializing > 0;
}

/** Is a client (the app / PWA) connected? Pilot's /health reports `clients`. A connected
 *  viewer means "don't restart under them" — surface the card instead of auto-applying. */
export function hasClientsFromHealth(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const c = (body as Record<string, unknown>).clients;
  return typeof c === "number" && c > 0;
}

/** Notify (card + native) at most once per target sha, so a session that runs for an
 *  hour doesn't buzz every interval. Re-notifies only when origin/main moves again. */
export function shouldNotify(
  target: string | null,
  lastNotified: string | null,
): boolean {
  return target !== null && target !== lastNotified;
}

// ─────────────────────────────── thin IO ───────────────────────────────

function log(msg: string): void {
  // Human channel → stderr, so stdout stays a clean event stream for the shell.
  process.stderr.write(`[update-watcher] ${msg}\n`);
}

/** Machine channel → stdout, one JSON object per line. The desktop shell parses these
 *  to drive the sidebar update card and native notifications. */
function emitEvent(event: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
  );
}

interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command, capture output, throw loud on non-zero (per the house "crash, don't
 *  paper over it" rule — the caller's tick handler logs and retries next interval). */
async function capture(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<CaptureResult> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `\`${cmd} ${args.join(" ")}\` exited ${code}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return { code, stdout, stderr };
}

interface CompareResult {
  /** git HEAD of the clone. */
  local: string;
  /** Tracked remote ref (origin/main). */
  remote: string;
  /** Full sha vite stamped into the served bundle, or null if no build has run yet. */
  built: string | null;
  /** Is the *served* bundle behind origin/main? (built !== remote, see isBuildStale.) */
  behind: boolean;
}

/** The full sha vite stamped into the built bundle (client/dist/.pilot-built-sha), or null
 *  if no build has run yet. This — not git HEAD — is what's actually served, so it's the
 *  honest answer to "what version is the user looking at". */
async function readBuiltSha(clone: string): Promise<string | null> {
  const f = Bun.file(join(clone, "client", "dist", ".pilot-built-sha"));
  return (await f.exists()) ? (await f.text()).trim() || null : null;
}

/** Fetch, then compare the *built* bundle to the tracked remote ref (see isBuildStale for
 *  why built-vs-remote, not HEAD-vs-remote). A non-fast-forwardable divergence surfaces
 *  later when the --ff-only pull fails loud, which is the right place to notice a rewritten
 *  history. */
async function fetchAndCompare(cfg: WatcherConfig): Promise<CompareResult> {
  await capture("git", [
    "-C",
    cfg.clone,
    "fetch",
    cfg.remote,
    cfg.branch,
    "--quiet",
  ]);
  const local = (
    await capture("git", ["-C", cfg.clone, "rev-parse", "HEAD"])
  ).stdout.trim();
  const remote = (
    await capture("git", [
      "-C",
      cfg.clone,
      "rev-parse",
      `${cfg.remote}/${cfg.branch}`,
    ])
  ).stdout.trim();
  const built = await readBuiltSha(cfg.clone);
  return { local, remote, built, behind: isBuildStale(built, remote) };
}

interface HostState {
  clientsConnected: boolean;
  busy: boolean;
}

/** Read host state from /health. Unreachable or non-OK → {no clients, not busy}: if the
 *  server isn't answering there's no UI to interrupt and no turn to protect, so the
 *  unattended-&-idle auto-apply path is safe. Logged so a persistently-down server is
 *  visible rather than silently treated as a green light. */
async function readHostState(healthUrl: string): Promise<HostState> {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      log(`/health returned ${res.status}; treating host as unattended & idle`);
      return { clientsConnected: false, busy: false };
    }
    const body = await res.json();
    return {
      clientsConnected: hasClientsFromHealth(body),
      busy: isBusyFromHealth(body),
    };
  } catch (e) {
    log(
      `/health unreachable (${String(e)}); treating host as unattended & idle`,
    );
    return { clientsConnected: false, busy: false };
  }
}

/** Tell the server the staged-update state (sha, or null when up to date) so it can show
 *  or clear the sidebar card, and learn back whether the user clicked "update now".
 *  `applyFailed` resets a stuck "applying" card. Any error → { applying: false }: a flaky
 *  report must never trigger an apply. */
async function reportUpdate(
  cfg: WatcherConfig,
  sha: string | null,
  applyFailed = false,
): Promise<{ applying: boolean }> {
  try {
    const res = await fetch(cfg.updateUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify({
        available: sha !== null,
        sha: sha ?? undefined,
        applyFailed,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      log(`/update/state returned ${res.status}`);
      return { applying: false };
    }
    const body = (await res.json()) as { applying?: boolean };
    return { applying: body.applying === true };
  } catch (e) {
    log(`/update/state unreachable (${String(e)})`);
    return { applying: false };
  }
}

async function readLock(clone: string): Promise<string | null> {
  const f = Bun.file(join(clone, "bun.lock"));
  return (await f.exists()) ? f.text() : null;
}

/** pull --ff-only → install (only if the lock moved) → build → ask server to restart. */
async function applyUpdate(cfg: WatcherConfig): Promise<void> {
  const before = await readLock(cfg.clone);
  await capture("git", [
    "-C",
    cfg.clone,
    "pull",
    "--ff-only",
    cfg.remote,
    cfg.branch,
  ]);
  const after = await readLock(cfg.clone);

  if (lockfileChanged(before, after)) {
    log("bun.lock changed — installing deps");
    await capture("bun", ["install", "--frozen-lockfile"], cfg.clone);
  }

  log("building client");
  await capture("bun", ["run", "build"], cfg.clone);

  await requestRestart(cfg);
}

export function parseServerPid(text: string): number | null {
  // Same format the pidlock writes (server/src/pidlock.ts): JSON {pid,serverId}, or a
  // bare int from run.sh before exec. Parse minimally rather than import server code.
  const raw = text.trim();
  if (!raw) return null;
  let pid: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    pid =
      typeof parsed === "number"
        ? parsed
        : parsed && typeof parsed === "object"
          ? (parsed as { pid?: unknown }).pid
          : Number.NaN;
  } catch {
    pid = Number(raw); // tolerate a hand-written bare int like "12345\n"
  }
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0
    ? pid
    : null;
}

function readServerPid(dataDir: string): number | null {
  const path = join(dataDir, "pilot.pid");
  if (!existsSync(path)) return null;
  return parseServerPid(readFileSync(path, "utf8"));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Ask the running server to exit so the supervisor respawns it from the updated clone.
 *  We only signal; we never respawn (see file header). No live pid → log + emit so the
 *  supervisor (or a human) knows a restart is owed. */
async function requestRestart(cfg: WatcherConfig): Promise<void> {
  const pid = readServerPid(cfg.dataDir);
  emitEvent({ event: "restart-requested", pid });
  if (pid && isPidAlive(pid)) {
    process.kill(pid, "SIGTERM");
    log(`sent SIGTERM to server pid ${pid}; supervisor should respawn it`);
  } else {
    log(
      "no live server pid in pilot.pid — supervisor must (re)start the server",
    );
  }
}

function nativeNotify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  // Best-effort; a missing/locked osascript must never break the loop.
  capture("osascript", [
    "-e",
    `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
  ]).catch(() => {});
}

/** Human-readable summary of what an apply would do. Distinguishes a genuine new commit
 *  (built/HEAD → remote) from a pure rebuild (HEAD already current, only the served bundle
 *  lags) so a self-heal doesn't log a confusing "X → X". */
function describeUpdate(c: CompareResult): string {
  const short = (s: string) => s.slice(0, 7);
  return c.local === c.remote
    ? `rebuild ${short(c.remote)} (served bundle stale)`
    : `${c.built ? short(c.built) : "none"} → ${short(c.remote)}`;
}

function notifyDeferred(cfg: WatcherConfig, c: CompareResult): void {
  emitEvent({
    event: "update-deferred",
    reason: "session-running",
    built: c.built,
    local: c.local,
    remote: c.remote,
  });
  log(`${describeUpdate(c)} ready; session running — deferring`);
  if (cfg.nativeNotify) {
    nativeNotify(
      "Pilot update ready",
      "New main is ready; applies when your session is idle.",
    );
  }
}

// ──────────────────────────────── loop ────────────────────────────────

export interface WatcherState {
  /** Last remote sha we surfaced a native notification for, to suppress repeats. */
  lastNotifiedSha: string | null;
  /** Date.now() of the last git fetch — throttles the network check to intervalMs while
   *  the loop itself can tick faster (pollMs) to keep the card's "update now" responsive. */
  lastFetchMs: number;
  /** Last fetch result, reused on fast polls so we don't re-fetch every pollMs. */
  cached: CompareResult | null;
}

export const initialState: WatcherState = {
  lastNotifiedSha: null,
  lastFetchMs: 0,
  cached: null,
};

/** One loop cycle. Fetches at most every intervalMs (fast polls reuse the cache); when an
 *  update is staged it reports availability to the server (→ card) and applies it on the
 *  user's click or when unattended & idle. Returns the next state; throws propagate to
 *  runWatcher's per-tick guard. */
export async function tick(
  cfg: WatcherConfig,
  state: WatcherState,
  now: number,
): Promise<WatcherState> {
  let { lastNotifiedSha, lastFetchMs, cached } = state;
  if (cached === null || now - lastFetchMs >= cfg.intervalMs) {
    cached = await fetchAndCompare(cfg);
    lastFetchMs = now;
  }
  const short = (s: string) => s.slice(0, 7);

  if (!cached.behind) {
    // Up to date — clear any card we'd surfaced, then idle.
    if (lastNotifiedSha !== null && !cfg.dryRun) await reportUpdate(cfg, null);
    return { lastNotifiedSha: null, lastFetchMs, cached };
  }

  const host = await readHostState(cfg.healthUrl);
  const action = decideAction({ behind: cached.behind, ...host });

  if (action === "apply") {
    // Unattended & idle → auto-apply (no card; nobody's watching to interrupt).
    log(`${describeUpdate(cached)}; unattended & idle — applying`);
    if (cfg.dryRun) {
      log("[dry-run] would pull/build/restart");
      return { lastNotifiedSha, lastFetchMs, cached };
    }
    await applyUpdate(cfg);
    return initialState; // re-fetch next tick to confirm up to date
  }

  // defer: a client is connected (or a turn is running). Report availability so the card
  // shows, and learn whether the user clicked "update now".
  if (cfg.dryRun) {
    log(`[dry-run] would surface update card (${short(cached.remote)})`);
    return { lastNotifiedSha: cached.remote, lastFetchMs, cached };
  }
  const { applying } = await reportUpdate(cfg, cached.remote);
  if (applying) {
    log(`update now requested — applying ${short(cached.remote)}`);
    try {
      await applyUpdate(cfg);
      return initialState;
    } catch (e) {
      log(`apply failed: ${e instanceof Error ? e.message : String(e)}`);
      await reportUpdate(cfg, cached.remote, true); // un-stick the card → offer retry
      return { lastNotifiedSha, lastFetchMs, cached };
    }
  }
  // Just deferring — native notification once per sha, only when a client can see it.
  if (host.clientsConnected && shouldNotify(cached.remote, lastNotifiedSha)) {
    notifyDeferred(cfg, cached);
    return { lastNotifiedSha: cached.remote, lastFetchMs, cached };
  }
  return { lastNotifiedSha, lastFetchMs, cached };
}

export async function runWatcher(cfg: WatcherConfig): Promise<never> {
  // Ask git, not a bare `.git` probe: the desktop app's clone is a plain `git clone`,
  // but `rev-parse` also accepts worktree/colocated layouts and confirms git is usable
  // there at all. Fail loud at startup rather than logging a fetch error every tick.
  try {
    await capture("git", ["-C", cfg.clone, "rev-parse", "--git-dir"]);
  } catch {
    throw new Error(
      `clone ${cfg.clone} is not a usable git repo — set PILOT_APP_CLONE to the ` +
        `dedicated checkout the desktop app runs from (a clean clone tracking ` +
        `${cfg.remote}/${cfg.branch}).`,
    );
  }
  const mismatch = originMismatch(cfg.healthUrl, cfg.updateUrl);
  if (mismatch) {
    log(
      `WARNING: /health and /update/state point at different servers (${mismatch}). ` +
        `The update card is driven by POST /update/state — if that's the wrong server the ` +
        `card never shows even though health-derived notifications still fire. Pin PILOT_PORT ` +
        `(or set PILOT_HEALTH_URL and PILOT_UPDATE_URL consistently).`,
    );
  }
  log(
    `watching ${cfg.clone} @ ${cfg.remote}/${cfg.branch} — fetch every ${cfg.intervalMs}ms, ` +
      `poll ${cfg.pollMs}ms (health ${cfg.healthUrl}, update ${cfg.updateUrl}` +
      `${cfg.dryRun ? ", DRY-RUN" : ""})`,
  );

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopping = true;
      log(`received ${sig} — stopping`);
      process.exit(0);
    });
  }

  let state = initialState;
  while (!stopping) {
    try {
      state = await tick(cfg, state, Date.now());
    } catch (e) {
      // Transient failures (network blip, server mid-restart) must not kill the
      // long-lived watcher — log loud and retry next interval.
      log(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Poll fast while an update is pending (snappy "update now"); otherwise sleep until
    // the next fetch is due.
    await Bun.sleep(state.cached?.behind ? cfg.pollMs : cfg.intervalMs);
  }
  process.exit(0);
}

if (import.meta.main) {
  await runWatcher(configFromEnv());
}
