import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLEANUP_SH = join(__dirname, "..", "cleanup-workspace.sh");

// Skip all tests in this file if jj is not installed (e.g. CI on Linux)
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
 * Create a throwaway jj repo for testing.
 */
function createJjRepo(cwd: string): void {
  run(["git", "init"], cwd);
  run(["jj", "git", "init", "--colocate"], cwd);
  run(["jj", "bookmark", "set", "main", "-r", "@"], cwd);
}

/**
 * Invoke cleanup-workspace.sh with PANTOKEN_REPO_ROOT set.
 */
function runCleanup(wsName: string, repoRoot: string): { stdout: string; stderr: string; exitCode: number } {
  return run(["bash", CLEANUP_SH, wsName], repoRoot, { PANTOKEN_REPO_ROOT: repoRoot });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "cleanup-ws-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describeOrSkip("cleanup-workspace.sh", () => {
  test("cleans up clean pushed workspace (AC.1)", () => {
    createJjRepo(tempDir);
    // Base commit on main
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    // Create a workspace at .workspaces/issue-42 with no commits above main
    const wsDir = join(tempDir, ".workspaces", "issue-42");
    mkdirSync(wsDir, { recursive: true });
    run(["jj", "workspace", "add", wsDir, "--name", "issue-42", "--revision", "main"], tempDir);

    // Verify workspace exists before cleanup
    const beforeList = run(["jj", "workspace", "list", "-T", 'name ++ "\\n"'], tempDir);
    expect(beforeList.stdout).toContain("issue-42");
    expect(existsSync(wsDir)).toBe(true);

    // Run cleanup
    const result = runCleanup("issue-42", tempDir);
    expect(result.exitCode).toBe(0);

    // Verify workspace is forgotten and dir removed
    const afterList = run(["jj", "workspace", "list", "-T", 'name ++ "\\n"'], tempDir);
    expect(afterList.stdout).not.toContain("issue-42");
    expect(existsSync(wsDir)).toBe(false);
  });

  test("retains workspace with dirty changes (AC.2)", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    const wsDir = join(tempDir, ".workspaces", "issue-42");
    mkdirSync(wsDir, { recursive: true });
    run(["jj", "workspace", "add", wsDir, "--name", "issue-42", "--revision", "main"], tempDir);

    // Make working changes dirty
    writeFileSync(join(wsDir, "dirty.txt"), "uncommitted\n");

    const result = runCleanup("issue-42", tempDir);
    expect(result.exitCode).toBe(1);

    // Workspace retained: still in list, dir still exists
    const afterList = run(["jj", "workspace", "list", "-T", 'name ++ "\\n"'], tempDir);
    expect(afterList.stdout).toContain("issue-42");
    expect(existsSync(wsDir)).toBe(true);
  });

  test("retains workspace with unpushed commits (AC.3)", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    const wsDir = join(tempDir, ".workspaces", "issue-42");
    mkdirSync(wsDir, { recursive: true });
    run(["jj", "workspace", "add", wsDir, "--name", "issue-42", "--revision", "main"], tempDir);

    // Create an unpushed commit in the workspace
    writeFileSync(join(wsDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "feature commit"], wsDir);
    run(["jj", "new"], wsDir); // empty working commit on top

    const result = runCleanup("issue-42", tempDir);
    expect(result.exitCode).toBe(1);

    // Workspace retained
    const afterList = run(["jj", "workspace", "list", "-T", 'name ++ "\\n"'], tempDir);
    expect(afterList.stdout).toContain("issue-42");
    expect(existsSync(wsDir)).toBe(true);
  });

  test("idempotent on unknown workspace name (AC.4)", () => {
    createJjRepo(tempDir);

    // Running cleanup on a name that doesn't exist should exit 0
    const result = runCleanup("issue-99", tempDir);
    expect(result.exitCode).toBe(0);
  });

  test("removes lingering dir for already-forgotten workspace (AC.4)", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    // Create workspace, then forget it manually (simulating prior cleanup)
    const wsDir = join(tempDir, ".workspaces", "issue-42");
    mkdirSync(wsDir, { recursive: true });
    run(["jj", "workspace", "add", wsDir, "--name", "issue-42", "--revision", "main"], tempDir);
    run(["jj", "workspace", "forget", "issue-42"], tempDir);

    // Dir lingers but workspace is forgotten from jj
    expect(existsSync(wsDir)).toBe(true);

    const result = runCleanup("issue-42", tempDir);
    expect(result.exitCode).toBe(0);
    expect(existsSync(wsDir)).toBe(false);
  });
});
