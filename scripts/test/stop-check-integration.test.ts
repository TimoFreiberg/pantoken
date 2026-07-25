import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Two committed copies of the stop hook exist: one under
 * scripts/polytoken-config/hooks/ (the autopilot marker variant) and one under
 * .polytoken/hooks/ (the implement-issue marker variant). They differ only in
 * marker filenames and comments — the logic is identical — so we run the same
 * suite against both.
 */
const HOOK_CONFIGS = [
  {
    name: "autopilot",
    hook: join(__dirname, "..", "polytoken-config", "hooks", "stop-check-integration.sh"),
    issueMarker: ".autopilot-issue-number",
    redirectMarker: ".autopilot-stop-redirects",
  },
  {
    name: "implement-issue",
    hook: join(__dirname, "..", "..", ".polytoken", "hooks", "stop-check-integration.sh"),
    issueMarker: ".implement-issue-number",
    redirectMarker: ".implement-issue-stop-redirects",
  },
] as const;

// Skip all tests if jj is not installed
const jjAvailable = spawnSync("jj", ["--version"], { encoding: "utf-8" }).status === 0;
const describeOrSkip = jjAvailable ? describe : describe.skip;

let tempDir: string;

function runHook(hookPath: string, env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", [hookPath], {
    cwd: tempDir,
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
  tempDir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "stop-hook-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

for (const cfg of HOOK_CONFIGS) {
  describeOrSkip(`stop-check-integration.sh (${cfg.name})`, () => {
    test("returns stop (exit 0, no output) when no issue number file exists", () => {
      createJjRepo(tempDir);
      const result = runHook(cfg.hook);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("returns stop when issue number exists but no unpushed commits", () => {
      createJjRepo(tempDir);
      writeFileSync(join(tempDir, cfg.issueMarker), "42");
      const result = runHook(cfg.hook);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("returns continue with redirect message when unpushed commits exist", () => {
      createJjRepo(tempDir);
      writeFileSync(join(tempDir, cfg.issueMarker), "42");
      writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

      const result = runHook(cfg.hook);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.outcome).toBe("continue");
      expect(parsed.reason).toContain("just integrate-into-main 42");
      expect(parsed.reason).toContain("Fixes #42");
      expect(parsed.reason).toContain("NOT yet integrated");
    });

    test("returns continue with correct issue number for a different issue", () => {
      createJjRepo(tempDir);
      writeFileSync(join(tempDir, cfg.issueMarker), "137");
      writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

      const result = runHook(cfg.hook);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.reason).toContain("Fixes #137");
      expect(parsed.reason).toContain("just integrate-into-main 137");
    });

    test("returns stop after MAX_REDIRECTS (3) continue redirects", () => {
      createJjRepo(tempDir);
      writeFileSync(join(tempDir, cfg.issueMarker), "42");
      writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

      // Simulate 3 prior redirects
      writeFileSync(join(tempDir, cfg.redirectMarker), "3");

      const result = runHook(cfg.hook);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.outcome).toBe("stop");
    });

    test("increments redirect counter on each continue", () => {
      createJjRepo(tempDir);
      writeFileSync(join(tempDir, cfg.issueMarker), "42");
      writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

      // First redirect
      let result = runHook(cfg.hook);
      expect(JSON.parse(result.stdout).outcome).toBe("continue");
      expect(readFileSync(join(tempDir, cfg.redirectMarker), "utf-8").trim()).toBe("1");

      // Second redirect
      result = runHook(cfg.hook);
      expect(JSON.parse(result.stdout).outcome).toBe("continue");
      expect(readFileSync(join(tempDir, cfg.redirectMarker), "utf-8").trim()).toBe("2");
    });

    test("clears redirect counter when integration is complete (no unpushed commits)", () => {
      createJjRepo(tempDir);
      writeFileSync(join(tempDir, cfg.issueMarker), "42");
      writeFileSync(join(tempDir, cfg.redirectMarker), "2");

      // No unpushed commits — should clear the counter and stop
      const result = runHook(cfg.hook);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      // Redirect file should be removed
      expect(() => readFileSync(join(tempDir, cfg.redirectMarker), "utf-8")).toThrow();
    });

    test("clears redirect counter after exhausted redirects let agent stop", () => {
      createJjRepo(tempDir);
      writeFileSync(join(tempDir, cfg.issueMarker), "42");
      writeCommit(tempDir, "feature.ts", "export const x = 1;\n");
      writeFileSync(join(tempDir, cfg.redirectMarker), "3");

      runHook(cfg.hook);
      expect(() => readFileSync(join(tempDir, cfg.redirectMarker), "utf-8")).toThrow();
    });
  });
}
