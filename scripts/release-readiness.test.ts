import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultReadinessTarget,
  runReleaseReadiness,
  validateReadinessInputs,
  type CommandRunner,
  type ReleaseReadinessOptions,
} from "./release-readiness.js";
import { runCapturedReleaseCommand, type ReleaseCommandExecutor } from "./lib/release-command.js";
import type { HeadlessBuildResult } from "./lib/headless-build.js";
import type { SpawnOptions } from "./lib/node-compat.js";

type RecordedCall = { command: string[]; cwd?: string; env?: NodeJS.ProcessEnv };

function baseOptions(root: string): ReleaseReadinessOptions {
  return {
    root,
    version: "1.2.3",
    buildSha: "a".repeat(40),
    target: defaultReadinessTarget(),
  };
}

describe("release readiness inputs", () => {
  it("rejects invalid versions and SHAs", () => {
    expect(() => validateReadinessInputs("1.2", "0".repeat(40), "x86_64-unknown-linux-gnu")).toThrow(/version/);
    expect(() => validateReadinessInputs("1.2.3", "bad", "x86_64-unknown-linux-gnu")).toThrow(/SHA/);
  });
  it("rejects unsupported targets", () => {
    expect(() => validateReadinessInputs("1.2.3", "0".repeat(40), "unknown-target")).toThrow(/unsupported/);
  });
});

describe("runReleaseReadiness default wiring", () => {
  it("preserves command order, environment scoping, and Buck2 output parsing", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-readiness-"));
    const calls: RecordedCall[] = [];
    const logs: string[] = [];
    const archiveSource = join(root, "fake-archive.tar.gz");
    const validatorSource = join(root, "fake-validator");
    try {
      const spawn = async (command: string[], options: SpawnOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> => {
        calls.push({ command, cwd: options.cwd, env: options.env });
        if (command[0] === "buck2") {
          const target = command[command.length - 1];
          const output = target === "//:pantoken_headless_unsigned" ? archiveSource : validatorSource;
          writeFileSync(output, target === "//:pantoken_headless_unsigned" ? "archive" : "validator");
          return { code: 0, stdout: `${target} ${output}\n`, stderr: "successful child stderr\n" };
        }
        return { code: 0, stdout: "successful child stdout\n", stderr: "successful child stderr\n" };
      };
      const executor: ReleaseCommandExecutor = (command, options) =>
        runCapturedReleaseCommand(command, options, {
          spawnAsync: spawn,
          now: (() => {
            let time = 0;
            return () => (time += 10);
          })(),
          log: (message) => logs.push(message),
        });

      const result = await runReleaseReadiness({ ...baseOptions(root), commandExecutor: executor });

      expect(calls.map(({ command }) => command)).toEqual([
        ["just", "test"],
        ["buck2", "build", "--config-file", ".buckconfig.ci", "--show-output", "//:pantoken_headless_unsigned"],
        ["buck2", "build", "--config-file", ".buckconfig.ci", "--show-output", "//server/pantoken-tar-validate:pantoken_tar_validate"],
        ["just", "validate-archive-rs-ci"],
        ["pnpm", "exec", "tsx", "scripts/headless/validate-artifact.ts", result.archivePath, "--version", "1.2.3"],
        ["tar", "xzf", result.archivePath, "-C", expect.any(String)],
        ["pnpm", "exec", "tsx", "scripts/headless/smoke-test.ts", expect.any(String)],
      ]);
      const validation = calls[4]!;
      expect(validation.env).toMatchObject({ PANTOKEN_TAR_VALIDATOR: result.validatorPath, PANTOKEN_UPDATE_TEST_MODE: "1" });
      expect(logs).toHaveLength(14);
      expect(logs.join("\n")).not.toContain(result.validatorPath);
      expect(logs.join("\n")).not.toContain("successful child stdout");
      expect(logs.join("\n")).not.toContain("successful child stderr");
      expect(existsSync(result.archivePath)).toBe(true);
      expect(existsSync(result.validatorPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("propagates captured executor diagnostics without swallowing them", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-readiness-failure-"));
    try {
      const logs: string[] = [];
      const executor: ReleaseCommandExecutor = (command, options) =>
        runCapturedReleaseCommand(command, options, {
          spawnAsync: async () => ({ code: 23, stdout: "readiness stdout", stderr: "readiness stderr" }),
          now: (() => {
            let time = 0;
            return () => (time += 250);
          })(),
          log: (message) => logs.push(message),
        });
      const error = await runReleaseReadiness({ ...baseOptions(root), commandExecutor: executor }).catch((caught) => caught as Error);
      expect(error.message).toMatch(/exit code 23[\s\S]*after 250ms[\s\S]*readiness stdout[\s\S]*readiness stderr/);
      expect(logs).toEqual([
        "release-readiness: start just test",
        expect.stringMatching(/release-readiness: stop just test \(failure, exit code 23, 250ms\)/),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves custom builders and the existing CommandRunner shape", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-readiness-custom-"));
    const calls: string[][] = [];
    try {
      const archivePath = join(root, "archive.tar.gz");
      const validatorPath = join(root, "validator");
      writeFileSync(archivePath, "archive");
      writeFileSync(validatorPath, "validator");
      const run: CommandRunner = async (command, options) => {
        calls.push(command);
        expect(options.cwd).toBe(root);
        if (command.some((part) => part.includes("validate-artifact.ts"))) {
          expect(options.env).toEqual({ PANTOKEN_TAR_VALIDATOR: validatorPath, PANTOKEN_UPDATE_TEST_MODE: "1" });
        } else {
          expect(options.env).toBeUndefined();
        }
      };
      const build = vi.fn(async (options: Parameters<NonNullable<ReleaseReadinessOptions["build"]>>[0]): Promise<HeadlessBuildResult> => {
        expect(Object.keys(options).sort()).toEqual(["asset", "buildSha", "outputDir", "root", "version"]);
        return { archivePath, validatorPath };
      });
      await runReleaseReadiness({ ...baseOptions(root), run, build });
      expect(build).toHaveBeenCalledOnce();
      expect(calls).toEqual([
        ["just", "test"],
        ["just", "validate-archive-rs-ci"],
        ["pnpm", "exec", "tsx", "scripts/headless/validate-artifact.ts", archivePath, "--version", "1.2.3"],
        ["tar", "xzf", archivePath, "-C", expect.any(String)],
        ["pnpm", "exec", "tsx", "scripts/headless/smoke-test.ts", expect.any(String)],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
