import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let tempDir: string;

/**
 * Run a command in the given directory, return {stdout, stderr, exitCode}.
 */
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

function runBash(script: string, cwd: string, env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", ["-c", script], {
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
 * Create a bare throwaway jj repo for testing finalize.sh logic.
 * We test the jj primitives (op log, rebase, bookmark move, op restore)
 * rather than the full script (which needs gh + network + worktree).
 */
beforeEach(() => {
  tempDir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "finalize-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("finalize.sh jj primitives", () => {
  test("jj op log captures current op ID for rollback", () => {
    // Init a git repo, then jj
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    const opResult = run(["jj", "op", "log", "--limit", "1", "--no-graph", "-T", "id"], tempDir);
    expect(opResult.exitCode).toBe(0);
    expect(opResult.stdout.length).toBeGreaterThan(0);
    // Op ID is a hex-ish string
    expect(opResult.stdout).toMatch(/^[0-9a-f]/);
  });

  test("jj rebase main..@ rebases only new commits onto destination", () => {
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    // Create a commit on main
    writeFileSync(join(tempDir, "file.txt"), "initial\n");
    run(["jj", "describe", "-m", "base commit"], tempDir);

    // Create a new change on top
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "feature commit"], tempDir);

    // Verify main..@ includes only the feature commit
    const logResult = run(["jj", "log", "-r", "main..@", "--no-graph", "-T", "description"], tempDir);
    expect(logResult.exitCode).toBe(0);
    expect(logResult.stdout).toContain("feature commit");
    expect(logResult.stdout).not.toContain("base commit");
  });

  test("jj bookmark move main --to @ advances bookmark", () => {
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    writeFileSync(join(tempDir, "file.txt"), "content\n");
    run(["jj", "describe", "-m", "first commit"], tempDir);
    run(["jj", "new"], tempDir);

    // Move main to current @
    const moveResult = run(["jj", "bookmark", "move", "main", "--to", "@"], tempDir);
    expect(moveResult.exitCode).toBe(0);

    // Verify main is now at @
    const logResult = run(["jj", "log", "-r", "main", "--no-graph", "-T", "description"], tempDir);
    expect(logResult.exitCode).toBe(0);
  });

  test("jj op restore rolls back to a previous state", () => {
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    // Create initial state
    writeFileSync(join(tempDir, "file.txt"), "original\n");
    run(["jj", "describe", "-m", "original"], tempDir);

    // Capture op ID
    const preOpResult = run(["jj", "op", "log", "--limit", "1", "--no-graph", "-T", "id"], tempDir);
    const preOpId = preOpResult.stdout;

    // Make a change
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "file2.txt"), "new file\n");
    run(["jj", "describe", "-m", "added file2"], tempDir);

    // Verify file2 exists
    expect(existsSync(join(tempDir, "file2.txt"))).toBe(true);

    // Roll back
    const restoreResult = run(["jj", "op", "restore", preOpId], tempDir);
    expect(restoreResult.exitCode).toBe(0);

    // file2 should no longer exist in the working copy
    expect(existsSync(join(tempDir, "file2.txt"))).toBe(false);
  });

  test("jj rebase -s main..@ -d main works on colocated repo", () => {
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    // Base commit
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);

    // Feature commit
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "feature"], tempDir);

    // Rebase main..@ onto main (should be a no-op since main is already parent)
    const rebaseResult = run(["jj", "rebase", "-s", "main..@", "-d", "main"], tempDir);
    expect(rebaseResult.exitCode).toBe(0);
  });

  test("finalize.sh requires an issue number argument", () => {
    const finalizeSh = join(__dirname, "..", "finalize.sh");
    const result = runBash(`bash "${finalizeSh}" 2>&1; true`, tempDir);
    expect(result.stdout).toContain("usage: finalize.sh <issue_number>");
  });
});
