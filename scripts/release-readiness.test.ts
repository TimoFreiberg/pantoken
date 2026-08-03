import { describe, expect, it } from "vitest";
import { computeReleasePlan } from "./desktop/release.js";
import { validateReadinessInputs } from "./release-readiness.js";

describe("release readiness inputs", () => {
  it("rejects invalid versions and SHAs", () => {
    expect(() => validateReadinessInputs("1.2", "0".repeat(40), "x86_64-unknown-linux-gnu")).toThrow(/version/);
    expect(() => validateReadinessInputs("1.2.3", "bad", "x86_64-unknown-linux-gnu")).toThrow(/SHA/);
  });
  it("rejects unsupported targets", () => {
    expect(() => validateReadinessInputs("1.2.3", "0".repeat(40), "unknown-target")).toThrow(/unsupported/);
  });
  it("plans an explicit version and exact SHA", () => {
    const sha = "a".repeat(40);
    expect(computeReleasePlan("1.2.3", "1.2.4", sha)).toMatchObject({ next: "1.2.4", buildSha: sha, tag: "v1.2.4" });
  });
});
