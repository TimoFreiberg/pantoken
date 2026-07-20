import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTEGRATE_SH = join(__dirname, "..", "integrate-into-main.sh");

// Skip all tests if jj is not installed (e.g. CI on Linux)
const jjAvailable = spawnSync("jj", ["--version"], { encoding: "utf-8" }).status === 0;
const describeOrSkip = jjAvailable ? describe : describe.skip;

let tempDir: string;

function run(cmd: string[], cwd: string, env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(cmd[0] ?? "", cmd.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? -1,
  };
}

/**
 * Create a throwaway jj repo with a local bare origin remote.
 * Returns the path to the bare origin repo.
 * Ported from integrate-into-main.test.ts.
 */
function createJjRepoWithOrigin(workspaceDir: string): string {
  const originDir = workspaceDir + "-origin.git";
  run(["git", "init", "--bare", originDir], "/tmp");
  run(["git", "init"], workspaceDir);
  run(["jj", "git", "init", "--colocate"], workspaceDir);
  run(["jj", "git", "remote", "add", "origin", originDir], workspaceDir);
  run(["jj", "bookmark", "set", "main", "-r", "@"], workspaceDir);
  return originDir;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "integrate-tolerance-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  // Also clean up the origin dir created alongside tempDir
  rmSync(tempDir + "-origin.git", { recursive: true, force: true });
});

describeOrSkip("integrate-into-main.sh tolerance (AC.5)", () => {
  test("integrate_tolerates_missing_session_id: exits 0 with no .autopilot-session-id, no commits above main", () => {
    createJjRepoWithOrigin(tempDir);

    // .merge-lock is gitignored in the real repo (so jj's colocated snapshot
    // ignores it). The temp repo lacks a .gitignore, so jj would snapshot the
    // lock file into a new commit on top of the immutable (pushed) @, creating
    // a phantom non-empty commit that defeats the no-commits early-exit.
    // Mirror the real repo's ignore by committing .gitignore as part of base.
    writeFileSync(join(tempDir, ".gitignore"), ".merge-lock\n");

    // Create a base commit (including the .gitignore) and push to establish main@origin
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "git", "push", "--bookmark", "main"], tempDir);

    // Deliberately DO NOT create .autopilot-session-id.
    // No commits above main (working copy is empty, on top of main).
    // The script should acquire the lock with CURRENT_SESSION="" and exit 0
    // at the "no non-empty commits" early-exit.
    const result = run(
      ["bash", INTEGRATE_SH, "42"],
      tempDir,
      // PANTOKEN_REPO_ROOT must point to tempDir so the lock file lands there
      // (not the real repo root).
      { PANTOKEN_REPO_ROOT: tempDir },
    );

    expect(result.exitCode).toBe(0);
    // Lock should be released after the no-op early-exit.
    expect(existsSync(join(tempDir, ".merge-lock"))).toBe(false);
  });
});
