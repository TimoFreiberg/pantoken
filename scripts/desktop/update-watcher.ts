#!/usr/bin/env bun
// update-watcher.ts — the brain of the desktop app's auto-update.
//
// Polls a *dedicated clone* (the one the desktop app runs from — NOT your dev tree)
// for new commits on origin/main and keeps it current without stomping live work:
//
//   • host idle    → apply immediately (pull → install if the lock moved → build →
//                     ask the server to restart). This is the "auto-update without
//                     asking" path.
//   • turn running → defer + emit an `update-deferred` event (the desktop shell turns
//                     it into the sidebar update card) and, on macOS standalone, a
//                     native notification. We re-check every tick, so the moment the
//                     session goes idle the next tick applies it.
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
  /** Unauthenticated /health URL of the running server (carries `busy`). */
  healthUrl: string;
  /** Data dir holding `pilot.pid` (the server's recorded pid; our restart signal). */
  dataDir: string;
  intervalMs: number;
  /** Detect + decide + log, but mutate nothing (no pull/build/restart/notify). */
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
  return {
    clone: process.env.PILOT_APP_CLONE ?? join(homedir(), "pilot-app"),
    remote: process.env.PILOT_UPDATE_REMOTE ?? "origin",
    branch: process.env.PILOT_UPDATE_BRANCH ?? "main",
    healthUrl:
      process.env.PILOT_HEALTH_URL ?? `http://127.0.0.1:${port}/health`,
    dataDir: process.env.PILOT_DATA_DIR ?? defaultDataDir(),
    intervalMs: Number(process.env.PILOT_UPDATE_INTERVAL_MS ?? 60_000),
    dryRun:
      process.env.PILOT_UPDATE_DRY_RUN === "1" || argv.includes("--dry-run"),
    nativeNotify: process.env.PILOT_UPDATE_NATIVE_NOTIFY !== "0",
  };
}

// ─────────────────────────── pure decision logic ───────────────────────────

export type Action = "apply" | "defer" | "noop";

/** The whole policy in one place: up-to-date → noop; behind + idle → apply; behind +
 *  busy → defer (never interrupt a turn). Deferred updates apply on a later tick once
 *  the host goes idle (tick re-evaluates every interval) — that's the literal reading
 *  of "auto-update when no session is running". Flip the `busy` branch to "noop" if you
 *  ever want defer to require an explicit apply instead of auto-applying on idle. */
export function decideAction(o: { behind: boolean; busy: boolean }): Action {
  if (!o.behind) return "noop";
  return o.busy ? "defer" : "apply";
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
  local: string;
  remote: string;
  behind: boolean;
}

/** Fetch, then compare local HEAD to the tracked remote ref. `behind` is just
 *  "they differ" — a non-fast-forwardable divergence surfaces later when the
 *  --ff-only pull fails loud, which is the right place to notice a rewritten history. */
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
  return { local, remote, behind: local !== remote };
}

/** Poll /health for `busy`. Unreachable or non-OK → treat as idle: if the server isn't
 *  answering there's no live turn to protect, so applying (then restarting it) is safe.
 *  Logged so a persistently-down server is visible rather than silently "idle". */
async function checkBusy(healthUrl: string): Promise<boolean> {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      log(`/health returned ${res.status}; treating host as idle`);
      return false;
    }
    return isBusyFromHealth(await res.json());
  } catch (e) {
    log(`/health unreachable (${String(e)}); treating host as idle`);
    return false;
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

function notifyDeferred(cfg: WatcherConfig, c: CompareResult): void {
  const short = (s: string) => s.slice(0, 7);
  emitEvent({
    event: "update-deferred",
    reason: "session-running",
    local: c.local,
    remote: c.remote,
  });
  log(
    `update ${short(c.local)} → ${short(c.remote)} ready; session running — deferring`,
  );
  if (cfg.nativeNotify) {
    nativeNotify(
      "Pilot update ready",
      "New main is ready; applies when your session is idle.",
    );
  }
}

// ──────────────────────────────── loop ────────────────────────────────

export interface WatcherState {
  /** Last remote sha we surfaced a defer for, to suppress repeat notifications. */
  lastNotifiedSha: string | null;
}

export const initialState: WatcherState = { lastNotifiedSha: null };

/** One poll cycle. Returns the next state. Pure-ish orchestration over the IO helpers;
 *  throws propagate to runWatcher's per-tick guard. */
export async function tick(
  cfg: WatcherConfig,
  state: WatcherState,
): Promise<WatcherState> {
  const cmp = await fetchAndCompare(cfg);
  if (!cmp.behind) return initialState; // up to date — clear any pending defer

  const busy = await checkBusy(cfg.healthUrl);
  const action = decideAction({ behind: cmp.behind, busy });
  const short = (s: string) => s.slice(0, 7);

  if (action === "apply") {
    log(
      `update ${short(cmp.local)} → ${short(cmp.remote)}; host idle — applying`,
    );
    if (cfg.dryRun) {
      log("[dry-run] would pull/build/restart");
      return state;
    }
    await applyUpdate(cfg);
    return initialState;
  }

  // defer
  if (shouldNotify(cmp.remote, state.lastNotifiedSha)) {
    if (cfg.dryRun) {
      log(`[dry-run] would defer + notify (${short(cmp.remote)})`);
    } else {
      notifyDeferred(cfg, cmp);
    }
    return { lastNotifiedSha: cmp.remote };
  }
  return state;
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
  log(
    `watching ${cfg.clone} @ ${cfg.remote}/${cfg.branch} every ${cfg.intervalMs}ms ` +
      `(health ${cfg.healthUrl}${cfg.dryRun ? ", DRY-RUN" : ""})`,
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
      state = await tick(cfg, state);
    } catch (e) {
      // Transient failures (network blip, server mid-restart) must not kill the
      // long-lived watcher — log loud and retry next interval.
      log(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await Bun.sleep(cfg.intervalMs);
  }
  process.exit(0);
}

if (import.meta.main) {
  await runWatcher(configFromEnv());
}
