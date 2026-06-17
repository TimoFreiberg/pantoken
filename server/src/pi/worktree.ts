// Create an isolated jj/git worktree of a repo directory, so a session can run on a
// clean copy of the tree (the new-session "worktree" toggle). The command/path planning
// is a pure function (unit-tested); only `createWorktree` touches disk + spawns the VCS.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Vcs = "jj" | "git";

/** Detect the VCS backing a directory. Prefers jj (the project's VCS) when a repo is
 *  colocated jj+git. Returns null when the dir isn't a recognized repo. */
export function detectVcs(repoDir: string): Vcs | null {
  if (existsSync(join(repoDir, ".jj"))) return "jj";
  if (existsSync(join(repoDir, ".git"))) return "git";
  return null;
}

/** Pure: plan the worktree path + the command to create it. Side-effect-free so it can
 *  be unit-tested without touching disk. The worktree is a sibling dir of the repo. */
export function planWorktree(
  repoDir: string,
  vcs: Vcs,
  id: string,
): { path: string; command: string; args: string[] } {
  const base = resolve(repoDir).replace(/\/+$/, "");
  const name = `pilot-${id}`;
  const path = `${base}-${name}`;
  if (vcs === "jj")
    return {
      path,
      command: "jj",
      args: ["-R", base, "workspace", "add", "--name", name, path],
    };
  // git: a detached worktree at HEAD avoids inventing (and later colliding on) a branch.
  return {
    path,
    command: "git",
    args: ["-C", base, "worktree", "add", "--detach", path],
  };
}

/** Create an isolated worktree of `repoDir` and return its absolute path. Throws loudly
 *  if the dir isn't a jj/git repo or the VCS command fails — the caller surfaces it to
 *  the UI rather than silently falling back to the shared tree. */
export async function createWorktree(
  repoDir: string,
  id: string = Date.now().toString(36),
): Promise<string> {
  const vcs = detectVcs(repoDir);
  if (!vcs)
    throw new Error(
      `cannot create a worktree: ${repoDir} is not a jj or git repository`,
    );
  const { path, command, args } = planWorktree(repoDir, vcs, id);
  await run(command, args);
  return path;
}
