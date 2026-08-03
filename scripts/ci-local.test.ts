import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gateSpecs,
  mockShardCount,
  mockShardPorts,
  runGates,
  selectGates,
  resolvePrerequisites,
} from "./ci-local.js";

describe("local CI runner", () => {
  it("shards mock E2E by min(CPUs, useful partitions, 4) and assigns unique ports", () => {
    expect(mockShardCount(16)).toBe(4);
    expect(mockShardCount(2)).toBe(2);
    expect(mockShardPorts(4)).toEqual([15173, 15183, 15193, 15203]);
    expect(new Set(mockShardPorts(4)).size).toBe(4);
    expect(gateSpecs({ host: "linux", cpuCount: 2 }).find((g) => g.name === "web-e2e")?.commands)
      .toEqual([
        "PANTOKEN_E2E_VITE_PORT=15173 pnpm run test:e2e --shard=1/2",
        "PANTOKEN_E2E_VITE_PORT=15183 pnpm run test:e2e --shard=2/2",
      ]);
  });

  it("reports host-unavailable gates and blocks missing applicable prerequisites", async () => {
    expect(selectGates("linux").find((g) => g.name === "desktop")).toMatchObject({ status: "skipped", reason: "host unavailable" });
    expect(selectGates("macos").filter((g) => g.status === "applicable").map((g) => g.name)).toEqual(["desktop", "buck2"]);
    const result = await resolvePrerequisites("linux", {}, async () => false);
    expect(result.blocked).toEqual(expect.arrayContaining([expect.stringContaining("pnpm"), expect.stringContaining("buck2"), expect.stringContaining("cargo")]));
  });

  it("does not launch Linux CI web gates on macOS", async () => {
    const launched: string[] = [];
    const results = await runGates({ host: "macos", selectedGates: ["web-check", "web-e2e", "web-live", "rust-server", "desktop", "buck2"], execute: async (spec) => { launched.push(spec.name); return 0; } });
    expect(launched).toEqual(["desktop", "buck2"]);
    expect(results.filter((result) => result.status === "skipped").map((result) => result.name)).toEqual(["rust-server", "web-check", "web-e2e", "web-live"]);
  });

  it("aggregates parallel gate failures and retains logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "ci-local-"));
    const started: string[] = [];
    const results = await runGates({
      host: "linux", selectedGates: ["web-check", "web-live"], logRoot: root, retainLogs: true,
      execute: async (spec, logPath) => {
        started.push(spec.name);
        const delay = spec.name === "web-check" ? 20 : 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        await import("node:fs/promises").then(({ writeFile }) => writeFile(logPath, `${spec.name} output`));
        return spec.name === "web-check" ? 2 : 0;
      },
    });
    expect(started).toEqual(expect.arrayContaining(["web-check", "web-live"]));
    expect(results.find((r) => r.name === "web-check")).toMatchObject({ status: "failed", exitCode: 2 });
    const logPath = results.find((r) => r.name === "web-check")?.logPath;
    expect(logPath).toBeDefined();
    expect(await readFile(logPath!, "utf8")).toContain("web-check output");
    expect(await stat(logPath!)).toBeTruthy();
  });

  it("keeps ci-local free of release-config archive commands", () => {
    const commands = gateSpecs({ host: "linux" }).flatMap((gate) => gate.commands).join("\n");
    expect(commands).not.toContain("validate-archive-rs-ci");
    expect(commands).not.toContain(".buckconfig.ci");
  });
});
