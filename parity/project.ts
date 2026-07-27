// parity/project.ts — create/reset the isolated test project.
//
// The project is the session cwd shared by the GUI and the TUI. It's a git repo (so
// VCS-aware features — trust, worktrees — have a repo to work in) and lives OUTSIDE the
// pantoken checkout (under PARITY_ROOT) so a driven session never nests in or mutates pantoken.

import { cpSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureEnv, paths, type Paths } from "./lib.ts";
import { spawnAsync, isMain } from "../scripts/lib/node-compat.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** The fixture source directory copied into the test project. Defaults to
 *  `parity/fixtures/project`; override with $PANTOKEN_PARITY_FIXTURE (relative to
 *  the pantoken checkout root or absolute) to point at an alternative fixture
 *  (e.g. the at-mention edge-case fixture for @-autocomplete comparison). */
const FIXTURE = (() => {
  const override = process.env.PANTOKEN_PARITY_FIXTURE?.trim();
  if (!override) return join(SCRIPT_DIR, "fixtures", "project");
  return override.startsWith("/")
    ? override
    : join(SCRIPT_DIR, "fixtures", override);
})();

/** Recreate $PARITY_ROOT/project from the fixture and git-init + commit once. Destructive:
 *  wipes any existing project dir first (it's a throwaway). */
export async function resetProject(p: Paths = paths()): Promise<string> {
  ensureEnv(p);
  rmSync(p.project, { recursive: true, force: true });
  cpSync(FIXTURE, p.project, { recursive: true });
  // git init + a single commit so trust/worktree code sees a real repo.
  const run = async (cmd: string[]) => {
    const result = await spawnAsync(cmd, {
      cwd: p.project,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "parity",
        GIT_AUTHOR_EMAIL: "parity@localhost",
        GIT_COMMITTER_NAME: "parity",
        GIT_COMMITTER_EMAIL: "parity@localhost",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((result.code ?? 1) !== 0) {
      throw new Error(
        `${cmd.join(" ")} failed (${result.code}): ${result.stderr.slice(0, 300)}`,
      );
    }
  };
  await run(["git", "init", "-q", "-b", "main"]);
  await run(["git", "add", "-A"]);
  await run(["git", "commit", "-q", "-m", "parity test project (seed)"]);
  return p.project;
}

/** Ensure the project AND the isolated env (dirs + generated config) exist; reset the
 *  project only if missing. ensureEnv runs unconditionally so the config.yaml is present
 *  even when the project dir already exists. */
export async function ensureProject(p: Paths = paths()): Promise<string> {
  ensureEnv(p);
  if (!existsSync(join(p.project, ".git"))) return resetProject(p);
  return p.project;
}

// CLI: `bun parity/project.ts reset|path|ensure`
if (isMain()) {
  const cmd = process.argv[2] ?? "ensure";
  const p = paths();
  if (cmd === "path") {
    console.log(p.project);
  } else if (cmd === "reset") {
    console.log(await resetProject(p));
  } else if (cmd === "ensure") {
    console.log(await ensureProject(p));
  } else {
    console.error(`usage: project.ts <reset|path|ensure>`);
    process.exit(1);
  }
}
