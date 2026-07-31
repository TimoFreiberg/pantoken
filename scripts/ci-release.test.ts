import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Static assertions on .github/workflows/ci.yml guarding the release-path
// invariants introduced by the "Buck2 release-authoritative" cutover:
//   - both release-prepare jobs build headless via `build.ts --builder buck2`
//   - no `cargo build` remains in the headless release path
//   - the Buck2⇄Cargo parity comparison step is gone (no CI consumer)
//   - the buck2 gate job is in the release job's `needs`
//   - the buck2 job exercises the release configuration (release_build=1)
//     and validates the archive with the same config file
const CI_YML = resolve(import.meta.dirname, "../.github/workflows/ci.yml");
const ci = readFileSync(CI_YML, "utf8");

/** Extract a top-level job block (from `  <name>:` to the next job or EOF). */
function jobBlock(name: string): string {
  const lines = ci.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`job '${name}' not found in ci.yml`);
  const end = lines.findIndex(
    (l, i) => i > start && /^  \S/.test(l) && !l.startsWith("    "),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("ci.yml release path (Buck2-authoritative)", () => {
  it("release-prepare builds headless via build.ts --builder buck2", () => {
    const block = jobBlock("release-prepare");
    expect(block).toContain("--builder buck2");
    expect(block).toContain('--tag "${{ github.ref_name }}"');
  });

  it("release-prepare-linux builds headless via build.ts --builder buck2", () => {
    const block = jobBlock("release-prepare-linux");
    expect(block).toContain("--builder buck2");
    expect(block).toContain("--target x86_64-unknown-linux-gnu");
    expect(block).toContain('--tag "${{ github.ref_name }}"');
  });

  it("has no cargo build in the release-prepare jobs (headless is Buck2-built)", () => {
    expect(jobBlock("release-prepare")).not.toMatch(/cargo\s+build/);
    expect(jobBlock("release-prepare-linux")).not.toMatch(/cargo\s+build/);
  });

  it("has no parity comparison step in the release path", () => {
    // The parity step (buck2-parity-compare.sh with continue-on-error) lived
    // in the release jobs; scope the assertions there so unrelated future
    // uses of continue-on-error elsewhere don't trip them.
    expect(jobBlock("release-prepare")).not.toContain("buck2-parity-compare.sh");
    expect(jobBlock("release-prepare")).not.toContain("continue-on-error");
    expect(jobBlock("release-prepare-linux")).not.toContain("buck2-parity-compare.sh");
    expect(jobBlock("release-prepare-linux")).not.toContain("continue-on-error");
  });

  it("puts the buck2 gate job in the release job's needs", () => {
    const block = jobBlock("release");
    expect(block).toMatch(/needs:\s*\[[^\]]*\bbuck2\b[^\]]*\]/);
  });

  it("runs the buck2 job's archive step in the release configuration", () => {
    const block = jobBlock("buck2");
    const archiveStep = block.match(
      /Buck2 archive build[\s\S]*?buck2 build [^\n]*\/\/:pantoken_headless_unsigned/,
    );
    expect(archiveStep).not.toBeNull();
    expect(archiveStep![0]).toContain("release_build = 1");
    expect(archiveStep![0]).toContain("--config-file .buckconfig.ci");
  });

  it("validates the archive with the same release config file", () => {
    const block = jobBlock("buck2");
    const validationStep = block.match(
      /Buck2 archive validation[\s\S]*?run: just validate-archive-rs-ci/,
    );
    expect(validationStep).not.toBeNull();
    // The recipe itself passes --config-file .buckconfig.ci so the sh_test
    // rebuilds its archive resource under the release config.
    const justfile = readFileSync(
      resolve(import.meta.dirname, "../justfile"),
      "utf8",
    );
    const recipe = justfile.match(/validate-archive-rs-ci:[\s\S]*?buck2 test[^\n]*/);
    expect(recipe).not.toBeNull();
    expect(recipe![0]).toContain("--config-file .buckconfig.ci");
  });
});
