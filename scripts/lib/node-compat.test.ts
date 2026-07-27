import { describe, expect, test } from "vitest";
import { spawnAsync, spawnManaged, streamText, sleep, isMain } from "./node-compat.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, chmodSync, realpathSync } from "node:fs";

describe("spawnAsync", () => {
  test("resolves with correct exit code", async () => {
    const result = await spawnAsync(["node", "-e", "process.exit(3)"]);
    expect(result.code).toBe(3);
  });

  test("resolves with exit code 0 on success", async () => {
    const result = await spawnAsync(["node", "-e", "process.exit(0)"]);
    expect(result.code).toBe(0);
  });

  test("captures full stdout", async () => {
    const result = await spawnAsync(["node", "-e", "console.log('hello out')"]);
    expect(result.stdout).toContain("hello out");
  });

  test("captures full stderr", async () => {
    const result = await spawnAsync([
      "node",
      "-e",
      "console.error('hello err')",
    ]);
    expect(result.stderr).toContain("hello err");
  });

  test("captures both stdout and stderr simultaneously", async () => {
    const result = await spawnAsync([
      "node",
      "-e",
      "console.log('out'); console.error('err')",
    ]);
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
  });

  test("captures multi-line output", async () => {
    const result = await spawnAsync([
      "node",
      "-e",
      "console.log('line1'); console.log('line2'); console.log('line3')",
    ]);
    expect(result.stdout).toContain("line1");
    expect(result.stdout).toContain("line2");
    expect(result.stdout).toContain("line3");
  });

  test("respects cwd option", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-test-"));
    const result = await spawnAsync(["node", "-e", "console.log(process.cwd())"], {
      cwd: dir,
    });
    // macOS resolves /var/folders → /private/var/folders; normalize both
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(dir));
  });

  test("respects env option", async () => {
    const result = await spawnAsync(
      ["node", "-e", "console.log(process.env.MY_TEST_VAR)"],
      { env: { ...process.env, MY_TEST_VAR: "test-value" } },
    );
    expect(result.stdout.trim()).toBe("test-value");
  });

  test("handles inherit stdio (no capture)", async () => {
    const result = await spawnAsync(["node", "-e", "process.exit(0)"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(result.code).toBe(0);
    // stdout/stderr are not captured when using "inherit"
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("spawnManaged", () => {
  test("exited resolves with the right exit code", async () => {
    const proc = spawnManaged(["node", "-e", "process.exit(42)"]);
    const code = await proc.exited;
    expect(code).toBe(42);
  });

  test("kill delivers a signal to the child", async () => {
    const proc = spawnManaged([
      "node",
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    // Give the child a moment to start
    await sleep(200);
    proc.kill("SIGTERM");
    const code = await proc.exited;
    // SIGTERM → null exit code (killed by signal), or 128+15=143
    expect(code).not.toBe(0);
  }, 10_000);

  test("pid is a positive number", () => {
    const proc = spawnManaged(["node", "-e", "setInterval(() => {}, 1000)"]);
    expect(proc.pid).toBeGreaterThan(0);
    proc.kill("SIGKILL");
  });

  test("stdin write+end works and echoes to stdout", async () => {
    // Create an executable script that echoes stdin to stdout
    const dir = mkdtempSync(join(tmpdir(), "echo-test-"));
    const scriptPath = join(dir, "echo.sh");
    writeFileSync(scriptPath, "#!/bin/bash\ncat\n");
    chmodSync(scriptPath, 0o755);

    const proc = spawnManaged([scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });

    // Start consuming stdout BEFORE writing to stdin, so we don't miss data
    const outputPromise = streamText(proc.stdout);

    if (proc.stdin) {
      proc.stdin.write("hello from stdin\n");
      proc.stdin.end();
    }

    const code = await proc.exited;
    expect(code).toBe(0);

    const output = await outputPromise;
    expect(output).toContain("hello from stdin");
  });
});

describe("sleep", () => {
  test("resolves after approximately the given delay", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("isMain", () => {
  test("returns false when imported as a module", () => {
    // This file is being imported by vitest, not run directly
    expect(isMain()).toBe(false);
  });
});
