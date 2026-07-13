import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "parse-triage.sh");

/**
 * Run parse-triage.sh with the given stdin, return {stdout, stderr, exitCode}.
 */
function runParser(input: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", [SCRIPT], {
    input,
    encoding: "utf-8",
    timeout: 10_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? -1,
  };
}

describe("parse-triage.sh", () => {
  test("extracts implementable JSON from surrounding text", () => {
    const input = `Analyzing issues...
I found a good candidate.
{"status":"implementable","issue_number":9,"issue_url":"https://github.com/TimoFreiberg/pantoken/issues/9","title":"space after @ autocomplete"}
Done.`;
    const result = runParser(input);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("implementable");
    expect(parsed.issue_number).toBe(9);
  });

  test("extracts no_work JSON", () => {
    const input = `No issues are implementable.
{"status":"no_work"}`;
    const result = runParser(input);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("no_work");
  });

  test("falls back to error on empty input", () => {
    const result = runParser("");
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("error");
  });

  test("falls back to error on malformed JSON", () => {
    const input = `Something went wrong.
{not valid json at all}`;
    const result = runParser(input);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("error");
  });

  test("extracts JSON when it's on the first line", () => {
    const input = `{"status":"no_work"}`;
    const result = runParser(input);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("no_work");
  });

  test("extracts JSON when there are lines that look like JSON but aren't valid", () => {
    const input = `Starting triage...
{"status":"implementable"  // missing closing brace
{"status":"implementable","issue_number":5,"issue_url":"https://github.com/TimoFreiberg/pantoken/issues/5","title":"test issue"}
end`;
    const result = runParser(input);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("implementable");
    expect(parsed.issue_number).toBe(5);
  });

  test("handles JSON with extra whitespace around it", () => {
    const input = `
  {"status":"no_work"}
`;
    const result = runParser(input);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("no_work");
  });
});
