import { describe, expect, it, vi } from "vitest";
import { computeReleasePlan, executeRelease } from "./release.js";

describe("release planning", () => {
  it("dry-run performs no readiness or writes", async () => {
    const readiness = vi.fn();
    await executeRelease(computeReleasePlan("1.0.0", "1.0.1", "a".repeat(40)), { root: "/nonexistent", dryRun: true, readiness: readiness as never });
    expect(readiness).not.toHaveBeenCalled();
  });
  it("readiness precedes mutation", async () => {
    const events: string[] = [];
    const runner = { capture: async (cmd: string[]) => { events.push(cmd[0]!); return ""; } };
    const readiness = async () => { events.push("readiness"); };
    await expect(executeRelease(computeReleasePlan("1.0.0", "1.0.1", "a".repeat(40)), { root: "/nonexistent", runner, readiness: readiness as never })).rejects.toThrow();
    expect(events).toEqual(["jj", "git", "readiness"]);
  });
});
