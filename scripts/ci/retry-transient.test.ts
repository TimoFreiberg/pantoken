import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Behavior tests for scripts/ci/retry-transient.sh: the CI wrapper that
// re-runs a failing command once when its output looks like a transient
// network/DNS failure (crates.io fetches), and never on any other failure.
const SCRIPT = resolve(import.meta.dirname, "retry-transient.sh");

interface RunResult {
  status: number;
  stdout: string;
}

function runScript(command: string): RunResult {
  try {
    const stdout = execFileSync("bash", [SCRIPT, command], {
      encoding: "utf8",
      env: { ...process.env, RETRY_TRANSIENT_SLEEP_SECONDS: "0" },
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "" };
  }
}

/** Fresh scratch dir + an attempt counter file initialized to "0". */
function scratch(): { dir: string; counter: string } {
  const dir = mkdtempSync(join(tmpdir(), "retry-transient-test-"));
  const counter = join(dir, "attempts");
  writeFileSync(counter, "0");
  return { dir, counter };
}

describe("scripts/ci/retry-transient.sh", () => {
  it("passes successful commands through unchanged", () => {
    const r = runScript("echo hello-world");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hello-world");
  });

  it("does not retry on a non-transient failure and preserves the exit code", () => {
    const { dir, counter } = scratch();
    const r = runScript(
      `n=$(cat '${counter}'); echo $((n + 1)) > '${counter}'; ` +
        `echo 'test assertion failed'; exit 42`,
    );
    expect(r.status).toBe(42);
    expect(readFileSync(counter, "utf8").trim()).toBe("1"); // ran exactly once
    rmSync(dir, { recursive: true, force: true });
  });

  it("retries once on a transient-looking failure and succeeds on the second attempt", () => {
    const { dir, counter } = scratch();
    const r = runScript(
      `n=$(cat '${counter}'); echo $((n + 1)) > '${counter}'; ` +
        `if [ "$n" = 0 ]; then ` +
        `echo 'error: dns error: failed to lookup address information: Temporary failure in name resolution' >&2; ` +
        `exit 1; ` +
        `fi; echo second-attempt-ok`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("second-attempt-ok");
    expect(readFileSync(counter, "utf8").trim()).toBe("2"); // original + retry
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails after the single retry when the transient failure persists", () => {
    const { dir, counter } = scratch();
    const r = runScript(
      `n=$(cat '${counter}'); echo $((n + 1)) > '${counter}'; ` +
        `echo "curl: (6) Could not resolve host: static.crates.io" >&2; exit 1`,
    );
    expect(r.status).toBe(1);
    expect(readFileSync(counter, "utf8").trim()).toBe("2"); // exactly one retry
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not retry on compile errors that merely mention network words", () => {
    // Rust compile/lint output can contain "network" innocently; that must
    // not trip the transient detector.
    const { dir, counter } = scratch();
    const r = runScript(
      `n=$(cat '${counter}'); echo $((n + 1)) > '${counter}'; ` +
        `echo 'error[E0432]: unresolved import: network'; exit 1`,
    );
    expect(r.status).toBe(1);
    expect(readFileSync(counter, "utf8").trim()).toBe("1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires a command argument", () => {
    expect(() => execFileSync("bash", [SCRIPT])).toThrow();
  });
});
