import { describe, expect, it, vi } from "vitest";
import type { SpawnOptions, SpawnResult } from "./node-compat.js";
import { runCapturedReleaseCommand, runReleaseCommand } from "./release-command.js";

describe("runCapturedReleaseCommand", () => {
  it("captures both streams and logs only timed status records on success", async () => {
    const logs: string[] = [];
    const calls: Array<{ command: string[]; options: SpawnOptions }> = [];
    const spawn = vi.fn(async (command: string[], options: SpawnOptions = {}): Promise<SpawnResult> => {
      calls.push({ command, options });
      return { code: 0, stdout: "child stdout secret", stderr: "child stderr secret" };
    });
    let time = 100;
    const result = await runCapturedReleaseCommand(
      ["just", "test"],
      { cwd: "/repo", env: { SECRET_RELEASE_VALUE: "do-not-log" } },
      { spawnAsync: spawn, now: () => (time += 125), log: (message) => logs.push(message) },
    );

    expect(result).toEqual({ code: 0, stdout: "child stdout secret", stderr: "child stderr secret" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ cwd: "/repo", stdout: "pipe", stderr: "pipe" });
    expect(calls[0]!.options.env).toEqual({ SECRET_RELEASE_VALUE: "do-not-log" });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("start just test");
    expect(logs[1]).toMatch(/stop just test \(success, \d+ms\)/);
    expect(logs.join("\n")).not.toContain("child stdout secret");
    expect(logs.join("\n")).not.toContain("child stderr secret");
    expect(logs.join("\n")).not.toContain("do-not-log");
  });

  it("reports exit status and complete captured diagnostics after the failure status", async () => {
    const logs: string[] = [];
    const error = await runCapturedReleaseCommand(
      ["validate", "archive"],
      { cwd: "/repo" },
      {
        spawnAsync: async () => ({ code: 17, stdout: "all stdout", stderr: "all stderr" }),
        now: (() => {
          let calls = 0;
          return () => (calls++ === 0 ? 1_000 : 2_250);
        })(),
        log: (message) => logs.push(message),
      },
    ).catch((caught) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected a rejected command to produce an Error");
    expect(error.message).toContain("validate archive");
    expect(error.message).toContain("exit code 17");
    expect(error.message).toContain("1.25s");
    expect(error.message).toContain("all stdout");
    expect(error.message).toContain("all stderr");
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("failure, exit code 17");
    expect(logs.join("\n")).not.toContain("all stdout");
  });

  it("reports a rejected spawn without claiming unavailable child streams", async () => {
    const logs: string[] = [];
    const startError = new Error("ENOENT: missing command");
    const error = await runCapturedReleaseCommand(
      ["missing-command"],
      {},
      {
        spawnAsync: async () => { throw startError; },
        now: (() => {
          let calls = 0;
          return () => (calls++ === 0 ? 10 : 210);
        })(),
        log: (message) => logs.push(message),
      },
    ).catch((caught) => caught as Error);

    if (!(error instanceof Error)) throw new Error("expected a rejected spawn to produce an Error");
    expect(error.message).toContain("missing-command");
    expect(error.message).toContain("ENOENT: missing command");
    expect(error.message).toContain("200ms");
    expect(error.message).not.toContain("stdout:");
    expect(error.message).not.toContain("stderr:");
    expect((error as Error & { cause?: unknown }).cause).toBe(startError);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("failure, start error");
  });

  it("adapts a successful result to the existing Promise<void> runner contract", async () => {
    const executor = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    await runReleaseCommand(
      ["just", "test"],
      { cwd: "/repo", env: { RELEASE_TEST_MODE: "1" } },
      executor,
    );
    expect(executor).toHaveBeenCalledWith(
      ["just", "test"],
      expect.objectContaining({ cwd: "/repo", env: expect.objectContaining({ RELEASE_TEST_MODE: "1" }) }),
    );
  });
});
