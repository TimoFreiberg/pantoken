// Node-compatible runtime helpers shared across scripts/ and parity/.
//
// These replace Bun-specific APIs with Node-standard equivalents that work
// under both Bun and Node (tsx). The design principle is minimal abstraction:
// only helpers where the Bun API's ergonomics differ significantly from Node's
// (subprocess .exited promise, isMain, sleep). Direct node:fs/promises,
// node:child_process spawnSync, node:net, node:url imports are preferred in
// each file for everything else.

import { spawn, type StdioOptions } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Writable, Readable } from "node:stream";

// ── Entrypoint detection ─────────────────────────────────────────────────
// Replaces `import.meta.main` (Bun-specific). Works under both Bun and Node/tsx.

export function isMain(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

// ── __dirname equivalent ────────────────────────────────────────────────
// Replaces `import.meta.dir` (Bun-specific). Returns the directory of the
// current module file.

export const scriptDir = dirname(fileURLToPath(import.meta.url));

// ── Sleep ───────────────────────────────────────────────────────────────
// Replaces `Bun.sleep(ms)`.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Subprocess types ────────────────────────────────────────────────────

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
  stdin?: "pipe" | "inherit" | "ignore";
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// A long-lived process handle that mirrors Bun.spawn's Subprocess API:
// .pid, .kill(), .exited (promise), and .stdin/.stdout/.stderr streams.
export interface ManagedProcess {
  readonly pid: number;
  kill(signal?: NodeJS.Signals): void;
  readonly exited: Promise<number | null>;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
}

function toStdio(
  channel: "pipe" | "inherit" | "ignore" | undefined,
  defaultVal: "pipe",
): "pipe" | "inherit" | "ignore" {
  return channel ?? defaultVal;
}

function buildStdioOptions(opts?: SpawnOptions): StdioOptions {
  const stdin = toStdio(opts?.stdin, "pipe");
  const stdout = toStdio(opts?.stdout, "pipe");
  const stderr = toStdio(opts?.stderr, "pipe");
  return [stdin, stdout, stderr];
}

// ── spawnAsync: fire-and-collect ────────────────────────────────────────
// Replaces the common Bun pattern:
//   const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
//   const code = await proc.exited;
//   const stdout = await new Response(proc.stdout).text();
//   const stderr = await new Response(proc.stderr).text();
//
// Collects all stdout/stderr into strings and resolves with { code, stdout, stderr }.

export function spawnAsync(
  cmd: string[],
  opts?: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd: opts?.cwd,
      env: opts?.env as NodeJS.ProcessEnv,
      stdio: buildStdioOptions(opts),
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

// ── spawnManaged: long-lived process with .exited promise ───────────────
// Replaces Bun.spawn for long-lived processes that need .pid, .kill(),
// .exited, and stream access (dev.ts, capture-daemon-corpus.ts, etc.).

export function spawnManaged(
  cmd: string[],
  opts?: SpawnOptions,
): ManagedProcess {
  const child = spawn(cmd[0]!, cmd.slice(1), {
    cwd: opts?.cwd,
    env: opts?.env as NodeJS.ProcessEnv,
    stdio: buildStdioOptions(opts),
  });

  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });

  return {
    pid: child.pid ?? -1,
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
    exited,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

// ── Stream text helper ──────────────────────────────────────────────────
// Replaces `await new Response(proc.stdout).text()` / `new Response(proc.stderr).text()`
// for cases where a ManagedProcess's stream needs to be fully consumed.
// Use with spawnManaged when you need both long-lived control AND full output.

export function streamText(stream: Readable | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (d: string) => {
      text += d;
    });
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
}
