import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gateSpecs } from "./ci-local.js";

const root = resolve(import.meta.dirname, "..");
const docs = readFileSync(resolve(root, "docs/local-ci-and-release.md"), "utf8");
const justfile = readFileSync(resolve(root, "justfile"), "utf8");

describe("local CI and release documentation contract", () => {
  it("documents recipes, controls, host skips, logs, and release exclusions", () => {
    expect(justfile).toContain("ci-local:");
    expect(justfile).toContain("release-readiness");
    for (const text of ["PANTOKEN_CI_CPUS", "PANTOKEN_CI_E2E_SHARDS", "PANTOKEN_CI_RETAIN_LOGS", "SKIPPED (host unavailable)", "target/ci-local", "does not sign"]) expect(docs).toContain(text);
  });

  it("keeps ci-local free of release-config archive commands", () => {
    const commands = gateSpecs({ host: "linux" }).flatMap((gate) => gate.commands).join("\n");
    expect(commands).not.toContain("validate-archive-rs-ci");
    expect(commands).not.toContain(".buckconfig.ci");
    expect(commands).toContain("cargo fmt --all -- --check");
    expect(commands).toContain("just test-rs");
  });
});
