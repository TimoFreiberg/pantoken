import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CI_YML = resolve(import.meta.dirname, "../.github/workflows/ci.yml");
const ci = readFileSync(CI_YML, "utf8");

function jobBlock(name: string): string {
  const lines = ci.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`job '${name}' not found in ci.yml`);
  const end = lines.findIndex(
    (line, index) => index > start && /^  \S/.test(line) && !line.startsWith("    "),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("ci.yml provider-free live gate", () => {
  it("runs the live tier for blocking tag, push, and relevant PR events", () => {
    const block = jobBlock("web-live");
    expect(block).toContain("needs: [detect-changes]");
    expect(block).not.toMatch(/if:\s*github\.event_name\s*==\s*'workflow_dispatch'/);
    expect(block).toContain("github.ref_type == 'tag'");
    expect(block).toContain("github.event_name == 'push'");
    expect(block).toContain("github.event_name == 'pull_request'");
    expect(block).toContain("needs.detect-changes.outputs.e2e-relevant == 'true'");
    expect(block).toContain("github.event_name == 'workflow_dispatch'");
  });

  it("retains the real fake-driver live command and diagnostics", () => {
    const block = jobBlock("web-live");
    expect(block).toContain("timeout-minutes: 30");
    expect(block).toContain("just build-server-rs");
    expect(block).toContain("pnpm exec playwright install --with-deps chromium");
    expect(block).toContain("pnpm run test:e2e:live");
    expect(readFileSync(resolve(import.meta.dirname, "../playwright.live.config.ts"), "utf8")).toContain("PANTOKEN_DRIVER=fake");
    expect(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")).toContain('"test:e2e:live"');
    expect(block).toContain("Upload traces on live e2e failure");
    expect(block).toContain("if: failure()");
    expect(block).toContain("path: test-results/");
  });
});
