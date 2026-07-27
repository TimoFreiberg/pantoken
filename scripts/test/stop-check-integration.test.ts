import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The stop hook is committed to the repo's .polytoken/hooks/. It gates on
 * `.workspaces/` + `.implement-issue-number` markers.
 */
const HOOK_PATH = join(__dirname, "..", "..", ".polytoken", "hooks", "stop-check-integration.sh");
const ISSUE_MARKER = ".implement-issue-number";
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
    const result = runHook(HOOK_PATH, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("returns stop when issue number exists but no unpushed commits", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    const result = runHook(HOOK_PATH, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("returns continue with redirect message when unpushed commits exist", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    const result = runHook(HOOK_PATH, tempDir);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("continue");
    expect(parsed.reason).toContain("just integrate-into-main 42");
    expect(parsed.reason).toContain("Fixes #42");
    expect(parsed.reason).toContain("NOT yet integrated");
  });

  test("returns continue with correct issue number for a different issue", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "137");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    const result = runHook(HOOK_PATH, tempDir);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.reason).toContain("Fixes #137");
    expect(parsed.reason).toContain("just integrate-into-main 137");
  });

  test("returns stop after MAX_REDIRECTS (3) continue redirects", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    // Simulate 3 prior redirects
    writeFileSync(join(tempDir, REDIRECT_MARKER), "3");

    const result = runHook(HOOK_PATH, tempDir);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("stop");
  });

  test("increments redirect counter on each continue", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    // First redirect
    let result = runHook(HOOK_PATH, tempDir);
    expect(JSON.parse(result.stdout).outcome).toBe("continue");
    expect(readFileSync(join(tempDir, REDIRECT_MARKER), "utf-8").trim()).toBe("1");

    // Second redirect
    result = runHook(HOOK_PATH, tempDir);
    expect(JSON.parse(result.stdout).outcome).toBe("continue");
    expect(readFileSync(join(tempDir, REDIRECT_MARKER), "utf-8").trim()).toBe("2");
  });

  test("clears redirect counter when integration is complete (no unpushed commits)", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    writeFileSync(join(tempDir, REDIRECT_MARKER), "2");

    // No unpushed commits — should clear the counter and stop
    const result = runHook(HOOK_PATH, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    // Redirect file should be removed
    expect(() => readFileSync(join(tempDir, REDIRECT_MARKER), "utf-8")).toThrow();
  });

  test("clears redirect counter after exhausted redirects let agent stop", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");
    writeFileSync(join(tempDir, REDIRECT_MARKER), "3");

    runHook(HOOK_PATH, tempDir);
    expect(() => readFileSync(join(tempDir, REDIRECT_MARKER), "utf-8")).toThrow();
  });

  test("stop_hook_no_op_when_not_under_workspaces (AC.5): exits 0 with no output even with marker + unpushed commits", () => {
    // Use a temp dir NOT under .workspaces/ — the hook should exit 0 immediately
    const nonWorkspaceDir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "stop-hook-noop-"));
    try {
      createJjRepo(nonWorkspaceDir);
      writeFileSync(join(nonWorkspaceDir, ISSUE_MARKER), "42");
      writeCommit(nonWorkspaceDir, "feature.ts", "export const x = 1;\n");

      const result = runHook(HOOK_PATH, nonWorkspaceDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(nonWorkspaceDir, { recursive: true, force: true });
    }
  });

  test("stop_hook_fires_when_under_workspaces (AC.6): returns continue with unpushed commits + marker", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    const result = runHook(HOOK_PATH, tempDir);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("continue");
    expect(parsed.reason).toContain("just integrate-into-main 42");
  });

  test("writes_session_id_when_marker_absent (AC.1): creates .implement-issue-session-id from POLYTOKEN_SESSION_ID", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    const sessionId = "test-session-abc-123";
    const result = runHook(HOOK_PATH, tempDir, { POLYTOKEN_SESSION_ID: sessionId });

    // The hook should have continued (unpushed commits) AND written the session ID
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("continue");

    const sessionFile = join(tempDir, ".implement-issue-session-id");
    expect(readFileSync(sessionFile, "utf-8").trim()).toBe(sessionId);
  });

  test("does_not_overwrite_existing_session_id (AC.2): keeps the original .implement-issue-session-id across multiple hook invocations", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ISSUE_MARKER), "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    // Pre-write a session ID (simulating a prior stop in the same session)
    const originalSessionId = "original-session-id";
    writeFileSync(join(tempDir, ".implement-issue-session-id"), originalSessionId);

    // Run the hook with a DIFFERENT session ID in the env
    runHook(HOOK_PATH, tempDir, { POLYTOKEN_SESSION_ID: "different-session-id" });

    // The file should still contain the original value, not the env var
    const sessionFile = join(tempDir, ".implement-issue-session-id");
    expect(readFileSync(sessionFile, "utf-8").trim()).toBe(originalSessionId);
  });
});
