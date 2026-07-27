import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The stop hook is committed to the repo's .polytoken/hooks/. It searches
 * $POLYTOKEN_PROJECT_DIR/.workspaces/ for a workspace matching this session.
 */
const HOOK_PATH = join(__dirname, "..", "..", ".polytoken", "hooks", "stop-check-integration.sh");
const ISSUE_MARKER = ".implement-issue-number";
const SESSION_MARKER = ".implement-issue-session-id";
const REDIRECT_MARKER = ".implement-issue-stop-redirects";

// Skip all tests if jj is not installed
const jjAvailable = spawnSync("jj", ["--version"], { encoding: "utf-8" }).status === 0;
const describeOrSkip = jjAvailable ? describe : describe.skip;

let parent: string;
let tempDir: string;

function runHook(hookPath: string, cwd: string, env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", [hookPath], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 10_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? -1,
  };
}

function createJjRepo(cwd: string): void {
  spawnSync("git", ["init"], { cwd, encoding: "utf-8" });
  spawnSync("jj", ["git", "init", "--colocate"], { cwd, encoding: "utf-8" });
  spawnSync("jj", ["bookmark", "set", "main", "-r", "@"], { cwd, encoding: "utf-8" });
}

function writeCommit(cwd: string, file: string, content: string): void {
  spawnSync("jj", ["new"], { cwd, encoding: "utf-8" });
  writeFileSync(join(cwd, file), content);
}

/**
 * Sets up a workspace with the issue marker and session-ID marker, and returns
 * the env object needed for the hook to find it.
 *
 * @param wsDir   The workspace directory (under .workspaces/)
 * @param repoRoot The repo root (parent of .workspaces/)
 * @param sessionId The session ID to stamp
 * @param issueNumber The issue number
 * @returns env object with POLYTOKEN_PROJECT_DIR and POLYTOKEN_SESSION_ID
 */
function setupWorkspace(
  wsDir: string,
  repoRoot: string,
  sessionId: string,
  issueNumber: string,
): Record<string, string> {
  writeFileSync(join(wsDir, ISSUE_MARKER), issueNumber);
  writeFileSync(join(wsDir, SESSION_MARKER), sessionId);
  return {
    POLYTOKEN_PROJECT_DIR: repoRoot,
    POLYTOKEN_SESSION_ID: sessionId,
  };
}

beforeEach(() => {
  parent = mkdtempSync(join(process.env.TMPDIR || "/tmp", "stop-hook-test-"));
  tempDir = join(parent, ".workspaces", "issue-test");
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

describeOrSkip("stop-check-integration.sh", () => {
  test("returns stop (exit 0, no output) when no issue number file exists", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "sess-1", "42");
    // Remove the issue marker to simulate no marker
    rmSync(join(tempDir, ISSUE_MARKER));
    const result = runHook(HOOK_PATH, tempDir, env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("returns stop when issue number exists but no unpushed commits", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "sess-1", "42");
    const result = runHook(HOOK_PATH, tempDir, env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("returns continue with redirect message when unpushed commits exist", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "sess-1", "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    const result = runHook(HOOK_PATH, tempDir, env);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("continue");
    expect(parsed.reason).toContain("just integrate-into-main 42");
    expect(parsed.reason).toContain("Fixes #42");
    expect(parsed.reason).toContain("NOT yet integrated");
  });

  test("returns continue with correct issue number for a different issue", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "sess-1", "137");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    const result = runHook(HOOK_PATH, tempDir, env);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.reason).toContain("Fixes #137");
    expect(parsed.reason).toContain("just integrate-into-main 137");
  });

  test("returns stop after MAX_REDIRECTS (3) continue redirects", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "sess-1", "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    // Simulate 3 prior redirects
    writeFileSync(join(tempDir, REDIRECT_MARKER), "3");

    const result = runHook(HOOK_PATH, tempDir, env);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("stop");
  });

  test("increments redirect counter on each continue", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "sess-1", "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    // First redirect
    let result = runHook(HOOK_PATH, tempDir, env);
    expect(JSON.parse(result.stdout).outcome).toBe("continue");
    expect(readFileSync(join(tempDir, REDIRECT_MARKER), "utf-8").trim()).toBe("1");

    // Second redirect
    result = runHook(HOOK_PATH, tempDir, env);
    expect(JSON.parse(result.stdout).outcome).toBe("continue");
    expect(readFileSync(join(tempDir, REDIRECT_MARKER), "utf-8").trim()).toBe("2");
  });

  test("clears redirect counter when integration is complete (no unpushed commits)", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "sess-1", "42");
    writeFileSync(join(tempDir, REDIRECT_MARKER), "2");

    // No unpushed commits — should clear the counter and stop
    const result = runHook(HOOK_PATH, tempDir, env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    // Redirect file should be removed
    expect(() => readFileSync(join(tempDir, REDIRECT_MARKER), "utf-8")).toThrow();
  });

  test("clears redirect counter after exhausted redirects let agent stop", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "sess-1", "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");
    writeFileSync(join(tempDir, REDIRECT_MARKER), "3");

    runHook(HOOK_PATH, tempDir, env);
    expect(() => readFileSync(join(tempDir, REDIRECT_MARKER), "utf-8")).toThrow();
  });

  test("stop_hook_no_op_when_not_under_workspaces: exits 0 with no output even with marker + unpushed commits", () => {
    // Use a temp dir NOT under .workspaces/ — the hook should exit 0 immediately
    const nonWorkspaceDir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "stop-hook-noop-"));
    try {
      createJjRepo(nonWorkspaceDir);
      writeFileSync(join(nonWorkspaceDir, ISSUE_MARKER), "42");
      writeFileSync(join(nonWorkspaceDir, SESSION_MARKER), "sess-1");
      writeCommit(nonWorkspaceDir, "feature.ts", "export const x = 1;\n");

      // POLYTOKEN_PROJECT_DIR points to a dir with no .workspaces/ — no match
      const result = runHook(HOOK_PATH, nonWorkspaceDir, {
        POLYTOKEN_PROJECT_DIR: nonWorkspaceDir,
        POLYTOKEN_SESSION_ID: "sess-1",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(nonWorkspaceDir, { recursive: true, force: true });
    }
  });

  test("stop_hook_fires_when_under_workspaces: returns continue with unpushed commits + marker", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "sess-1", "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    const result = runHook(HOOK_PATH, tempDir, env);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("continue");
    expect(parsed.reason).toContain("just integrate-into-main 42");
  });

  // --- New tests for workspace discovery via session-ID matching ---

  test("stop_hook_finds_workspace_via_session_id_match (AC.4): marker + session-ID matching POLYTOKEN_SESSION_ID → continue", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "my-session-42", "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    const result = runHook(HOOK_PATH, parent, env);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("continue");
    expect(parsed.reason).toContain("just integrate-into-main 42");
  });

  test("stop_hook_no_op_when_no_marker_in_any_workspace (AC.5): no markers → exit 0, no output", () => {
    createJjRepo(tempDir);
    // No marker files written — just the jj repo
    const result = runHook(HOOK_PATH, parent, {
      POLYTOKEN_PROJECT_DIR: parent,
      POLYTOKEN_SESSION_ID: "sess-1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("stop_hook_no_op_when_session_id_not_found (AC.6): two workspaces, neither matches → exit 0", () => {
    // Create two workspaces with different session IDs
    const ws1 = join(parent, ".workspaces", "issue-1");
    const ws2 = join(parent, ".workspaces", "issue-2");
    mkdirSync(ws1, { recursive: true });
    mkdirSync(ws2, { recursive: true });
    createJjRepo(ws1);
    createJjRepo(ws2);
    writeFileSync(join(ws1, ISSUE_MARKER), "1");
    writeFileSync(join(ws1, SESSION_MARKER), "session-A");
    writeFileSync(join(ws2, ISSUE_MARKER), "2");
    writeFileSync(join(ws2, SESSION_MARKER), "session-B");

    // Our session ID matches neither
    const result = runHook(HOOK_PATH, parent, {
      POLYTOKEN_PROJECT_DIR: parent,
      POLYTOKEN_SESSION_ID: "session-C",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("stop_hook_no_op_when_single_candidate_does_not_match (AC.6): stale workspace must not redirect unrelated session", () => {
    createJjRepo(tempDir);
    // Workspace has a marker + session-ID, but for a DIFFERENT session
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    writeFileSync(join(tempDir, SESSION_MARKER), "other-session");

    const result = runHook(HOOK_PATH, parent, {
      POLYTOKEN_PROJECT_DIR: parent,
      POLYTOKEN_SESSION_ID: "my-session",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("stop_hook_detects_commits_from_repo_root_cwd (AC.7): hook runs with cwd=repoRoot, commits in workspace → continue", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "sess-1", "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    // Spawn the hook with cwd=parent (the repo root), not the workspace.
    // This catches the jj-log-CWD bug: if jj log runs in the hook's CWD
    // (repo root) instead of the workspace, it won't find the commits.
    const result = runHook(HOOK_PATH, parent, env);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("continue");
    expect(parsed.reason).toContain("just integrate-into-main 42");
  });

  test("continue message includes absolute workspace path (AC.8)", () => {
    createJjRepo(tempDir);
    const env = setupWorkspace(tempDir, parent, "sess-1", "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    const result = runHook(HOOK_PATH, parent, env);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.reason).toContain("pushd ");
    // The path should be the absolute workspace dir
    expect(parsed.reason).toContain(tempDir);
  });

  test("stop_hook_no_op_when_no_workspaces_dir (AC.5 edge): .workspaces/ doesn't exist → exit 0", () => {
    // Use a parent with no .workspaces/ dir
    const bareParent = mkdtempSync(join(process.env.TMPDIR || "/tmp", "stop-hook-bare-"));
    try {
      const result = runHook(HOOK_PATH, bareParent, {
        POLYTOKEN_PROJECT_DIR: bareParent,
        POLYTOKEN_SESSION_ID: "sess-1",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(bareParent, { recursive: true, force: true });
    }
  });

  test("stop_hook_no_op_when_session_id_unset: no POLYTOKEN_SESSION_ID → exit 0", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    writeFileSync(join(tempDir, SESSION_MARKER), "sess-1");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    // No POLYTOKEN_SESSION_ID in env
    const result = runHook(HOOK_PATH, parent, {
      POLYTOKEN_PROJECT_DIR: parent,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("stop_hook_no_op_when_project_dir_unset: no POLYTOKEN_PROJECT_DIR → falls back to PWD, no .workspaces match → exit 0", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    writeFileSync(join(tempDir, SESSION_MARKER), "sess-1");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    // No POLYTOKEN_PROJECT_DIR — hook falls back to $PWD which is tempDir,
    // but tempDir IS the workspace, not the repo root, so .workspaces/ won't
    // be found under it. Exit 0.
    const result = runHook(HOOK_PATH, tempDir, {
      POLYTOKEN_SESSION_ID: "sess-1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});
