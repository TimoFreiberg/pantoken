import { describe, expect, it } from "vitest";
import { gateSpecs } from "./ci-local.js";

describe("local CI and release command contract", () => {
  it("keeps ci-local free of release-config archive commands", () => {
    const commands = gateSpecs({ host: "linux" }).flatMap((gate) => gate.commands).join("\n");
    expect(commands).not.toContain("validate-archive-rs-ci");
    expect(commands).not.toContain(".buckconfig.ci");
    expect(commands).toContain("cargo fmt --all -- --check");
    expect(commands).toContain("just test-rs");
  });
});
