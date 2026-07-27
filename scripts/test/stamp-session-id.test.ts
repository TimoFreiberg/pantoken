import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The stamp-session-id hook is a post_tool_use hook for pushd. It reads
 * the pushd target from event JSON on stdin and stamps the workspace with
 * POLYTOKEN_SESSION_ID.
 */
const HOOK_PATH = join(__dirname, "..", "..", ".polytoken", "hooks", "stamp-session-id.sh");
const SESSION_MARKER = ".implement-issue-session-id";

// Skip all tests if jq is not installed
const jqAvailable = spawnSync("jq", ["--version"], { encoding: "utf-8" }).status === 0;
const describeOrSkip = jqAvailable ? describe : describe.skip;

let parent: string;
let repoRoot: string;
let workspaceDir: string;

function runStampHook(
  eventJson: string,
  env: Record<string, string> = {},
  cwd?: string,
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", [HOOK_PATH], {
    cwd: cwd ?? repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    input: eventJson,
    timeout: 10_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? -1,
  };
}

function makeEventJson(path: string): string {
  return JSON.stringify({ input: { path } });
}

beforeEach(() => {
  parent = mkdtempSync(join(process.env.TMPDIR || "/tmp", "stamp-hook-test-"));
  repoRoot = parent;
  workspaceDir = join(repoRoot, ".workspaces", "issue-test");
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

describeOrSkip("stamp-session-id.sh", () => {
  test("writes_session_id_when_pushd_into_workspace (AC.1): stamps on any pushd into .workspaces/ direct child", () => {
    const sessionId = "test-session-abc-123";
    const result = runStampHook(makeEventJson(workspaceDir), {
      POLYTOKEN_PROJECT_DIR: repoRoot,
      POLYTOKEN_SESSION_ID: sessionId,
    });

    expect(result.exitCode).toBe(0);
    const sessionFile = join(workspaceDir, SESSION_MARKER);
    expect(existsSync(sessionFile)).toBe(true);
    expect(readFileSync(sessionFile, "utf-8").trim()).toBe(sessionId);
  });

  test("writes_session_id_without_issue_marker (AC.1): stamps even when .implement-issue-number does NOT exist", () => {
    // This is the critical design decision: the first pushd (Step 0) happens
    // before gh-issue-fetch.sh writes the marker. The stamp must fire anyway.
    const sessionId = "early-session-id";
    const result = runStampHook(makeEventJson(workspaceDir), {
      POLYTOKEN_PROJECT_DIR: repoRoot,
      POLYTOKEN_SESSION_ID: sessionId,
    });

    expect(result.exitCode).toBe(0);
    const sessionFile = join(workspaceDir, SESSION_MARKER);
    expect(existsSync(sessionFile)).toBe(true);
    expect(readFileSync(sessionFile, "utf-8").trim()).toBe(sessionId);
    // Confirm no issue marker was needed
    expect(existsSync(join(workspaceDir, ".implement-issue-number"))).toBe(false);
  });

  test("no_op_when_target_not_under_workspaces (AC.2): non-workspace path → no file written", () => {
    const nonWorkspaceDir = join(parent, "some-other-dir");
    mkdirSync(nonWorkspaceDir, { recursive: true });

    const result = runStampHook(makeEventJson(nonWorkspaceDir), {
      POLYTOKEN_PROJECT_DIR: repoRoot,
      POLYTOKEN_SESSION_ID: "sess-1",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(nonWorkspaceDir, SESSION_MARKER))).toBe(false);
  });

  test("no_op_when_session_id_unset (AC.2): POLYTOKEN_SESSION_ID not in env → no file written", () => {
    const result = runStampHook(makeEventJson(workspaceDir), {
      POLYTOKEN_PROJECT_DIR: repoRoot,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(workspaceDir, SESSION_MARKER))).toBe(false);
  });

  test("no_op_when_project_dir_unset (AC.2): POLYTOKEN_PROJECT_DIR not in env → no file written", () => {
    const result = runStampHook(makeEventJson(workspaceDir), {
      POLYTOKEN_SESSION_ID: "sess-1",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(workspaceDir, SESSION_MARKER))).toBe(false);
  });

  test("does_not_overwrite_different_session_id (AC.3): existing different session ID → no write", () => {
    const existingSessionId = "original-session-id";
    writeFileSync(join(workspaceDir, SESSION_MARKER), existingSessionId);

    const result = runStampHook(makeEventJson(workspaceDir), {
      POLYTOKEN_PROJECT_DIR: repoRoot,
      POLYTOKEN_SESSION_ID: "different-session-id",
    });

    expect(result.exitCode).toBe(0);
    // File should still contain the original value
    expect(readFileSync(join(workspaceDir, SESSION_MARKER), "utf-8").trim()).toBe(existingSessionId);
  });

  test("no_op_when_target_is_nested_descendant (AC.2): subdirectory of .workspaces/ child → no file", () => {
    const nestedDir = join(workspaceDir, "subdir");
    mkdirSync(nestedDir, { recursive: true });

    const result = runStampHook(makeEventJson(nestedDir), {
      POLYTOKEN_PROJECT_DIR: repoRoot,
      POLYTOKEN_SESSION_ID: "sess-1",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(nestedDir, SESSION_MARKER))).toBe(false);
  });

  test("same_session_id_is_idempotent: workspace already has same session ID → no error", () => {
    const sessionId = "same-session-id";
    writeFileSync(join(workspaceDir, SESSION_MARKER), sessionId);

    const result = runStampHook(makeEventJson(workspaceDir), {
      POLYTOKEN_PROJECT_DIR: repoRoot,
      POLYTOKEN_SESSION_ID: sessionId,
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(workspaceDir, SESSION_MARKER), "utf-8").trim()).toBe(sessionId);
  });

  test("no_op_when_event_has_no_path: empty/missing input.path → exit 0, no file", () => {
    const result = runStampHook(
      JSON.stringify({ input: {} }),
      {
        POLYTOKEN_PROJECT_DIR: repoRoot,
        POLYTOKEN_SESSION_ID: "sess-1",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(workspaceDir, SESSION_MARKER))).toBe(false);
  });

  test("stamps_correct_workspace_when_multiple_workspaces_exist: only stamps the pushd target", () => {
    const otherWorkspace = join(repoRoot, ".workspaces", "issue-other");
    mkdirSync(otherWorkspace, { recursive: true });

    const sessionId = "my-session";
    const result = runStampHook(makeEventJson(workspaceDir), {
      POLYTOKEN_PROJECT_DIR: repoRoot,
      POLYTOKEN_SESSION_ID: sessionId,
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(workspaceDir, SESSION_MARKER), "utf-8").trim()).toBe(sessionId);
    // The other workspace should NOT have been stamped
    expect(existsSync(join(otherWorkspace, SESSION_MARKER))).toBe(false);
  });
});
