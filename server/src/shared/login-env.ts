// Resolve which login shell would be used for an interactive-shell env capture, and
// report the live status of that capture for the Settings panel (configured vs active).
//
// The full interactive-shell env reconstruction (running `<shell> -l -i -c` to source rc
// files and merge the result into process.env) only applies to an in-process agent
// driver that spawns its shell tool with `{ ...process.env }`. Under polytoken the agent
// runs as an out-of-process daemon, so the env reconstruction is dead on this branch —
// only the shell-resolution + status-surfacing fns the hub calls live remain.

import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import type { LoginEnvStatus } from "@pilot/protocol";

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
