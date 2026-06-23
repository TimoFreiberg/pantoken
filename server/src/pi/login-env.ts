// Reconstruct the user's interactive-shell environment at startup and merge it into
// process.env, so the agent's shell tool sees the same PATH/tools a TUI launched from a
// terminal would.
//
// Why this exists: a TUI coding agent "just works" not because it sources your shell
// config, but because you launch it FROM an interactive shell that already populated its
// env (PATH, language-manager shims, exported keys) — the TUI inherits that, and passes
// it to every subprocess. Pilot has no interactive-shell ancestor: launchd (boot,
// headless) and the macOS .app (Finder/Dock) hand it a minimal env and source nothing.
// So pilot must RECONSTRUCT that env by actually running the login shell. (Same idea as
// VS Code's resolveShellEnv / Emacs's exec-path-from-shell.)
//
// The seam: pi runs in-process and spawns its bash tool with `{ ...process.env }`
// (see pi's utils/shell.ts), so enriching process.env once here reaches every agent
// command. The hardcoded launch PATH in the deploy plists / desktop Config.swift stays —
// it only needs to bootstrap bun; this layers the real env on top after.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import type { LoginEnvStatus } from "@pilot/protocol";
import { readPilotSettings } from "../settings-store.js";

// Vars pilot sets intentionally, or launch-context junk — the login shell's values must
// NOT clobber these. Everything else the shell exports wins (that's the point: a faithful
// env). PILOT_* is matched by prefix below.
const PROTECTED = new Set(["HOME", "PWD", "OLDPWD", "SHLVL", "_", "TMPDIR"]);

function isProtected(key: string): boolean {
  return key.startsWith("PILOT_") || PROTECTED.has(key);
}

// Printed right before the env dump so we can skip any stdout an rc file emitted during
// shell startup (rc runs before our `-c` command, so its noise is strictly before this).
const MARKER = "__PILOT_LOGIN_ENV__";

let status: LoginEnvStatus = {
  activeShell: null,
  ok: false,
  detail: "not captured",
};

/** Live status of the startup capture, for the Settings panel (configured vs active). */
export function getLoginEnvStatus(): LoginEnvStatus {
  return status;
}

/** Resolve which shell to run: the configured override wins, then `$SHELL`, then the
 *  OS passwd login shell, then sane fallbacks. Returns null if none exists on disk. */
export function resolveLoginShell(configured: string | null): string | null {
  const candidates = [
    configured,
    process.env.SHELL ?? null,
    userInfo().shell, // POSIX login shell from the passwd db; null on some platforms
    "/bin/zsh",
    "/bin/bash",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** Run `<shell> -l -i -c '<dump env>'` and parse the result. We dump env by running this
 *  same bun binary (absolute path, so PATH is irrelevant) as a child of the login shell —
 *  it inherits the shell's fully-sourced env, and `JSON.stringify(process.env)` is robust
 *  for any value (no `env -0` portability worry, no quoting of newlines). Rejects on spawn
 *  error / non-zero exit / timeout. */
function captureEnv(
  shell: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    // -l -i: login + interactive, so .zprofile/.zshrc (zsh), config.fish (fish) —
    // wherever PATH actually lives — all run, matching a real terminal. -c makes the
    // shell run the command and exit (no waiting for input); the timeout is the backstop
    // for an rc file that genuinely blocks.
    const dumper = `'${process.execPath}' -e 'process.stdout.write("${MARKER}"+JSON.stringify(process.env))'`;
    const child = spawn(shell, ["-l", "-i", "-c", dumper], {
      stdio: ["ignore", "pipe", "ignore"], // ignore rc-file stderr noise
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`exited with code ${code}`));
        return;
      }
      const out = Buffer.concat(chunks).toString("utf8");
      const at = out.indexOf(MARKER);
      if (at < 0) {
        reject(new Error("env marker not found in shell output"));
        return;
      }
      try {
        resolve(
          JSON.parse(out.slice(at + MARKER.length)) as Record<string, string>,
        );
      } catch (e) {
        reject(new Error(`could not parse env dump: ${(e as Error).message}`));
      }
    });
  });
}

/** Capture the login shell's environment ONCE at startup and merge it into process.env
 *  (pilot's own PILOT_* and HOME etc. win). Loud-warns and leaves the launch PATH intact on
 *  any failure — never a silent half-env. Idempotent enough to call once before the pi
 *  driver is created. */
export async function applyLoginEnv(timeoutMs = 10_000): Promise<void> {
  const configured = readPilotSettings().loginShell;
  const shell = resolveLoginShell(configured);
  if (!shell) {
    status = {
      activeShell: null,
      ok: false,
      detail: "no usable login shell found",
    };
    console.error(
      "[login-env] no usable login shell found; keeping launch PATH",
    );
    return;
  }
  try {
    const env = await captureEnv(shell, timeoutMs);
    let merged = 0;
    for (const [k, v] of Object.entries(env)) {
      if (isProtected(k)) continue;
      if (process.env[k] !== v) merged++;
      process.env[k] = v;
    }
    status = {
      activeShell: shell,
      ok: true,
      detail: `merged ${merged} var${merged === 1 ? "" : "s"} from ${shell}`,
    };
    console.log(
      `[login-env] captured env from ${shell} (${merged} vars merged)`,
    );
  } catch (e) {
    status = {
      activeShell: null,
      ok: false,
      detail: `capture via ${shell} failed: ${(e as Error).message}`,
    };
    console.error(
      `[login-env] capture via ${shell} failed; keeping launch PATH`,
      e,
    );
  }
}
