// Build the headless release archive + tar validator via Buck2.
// Extracted from scripts/headless/build.ts so it can be unit-tested without
// triggering the build script's top-level boot code.

import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnAsync, type SpawnResult } from "./node-compat.js";
import { parseBuck2ShowOutput } from "./build-server.js";
import type { ReleaseCommandExecutor } from "./release-command.js";

/** The [pantoken] config section written to .buckconfig.ci for release builds. */
export interface BuckConfigCi {
  version: string;
  buildSha: string;
  releaseBuild: boolean;
}

/** Serialize the [pantoken] config section that buck2 reads via --config-file. */
export function buckConfigCiContents(config: BuckConfigCi): string {
  return [
    "[pantoken]",
    `version = ${config.version}`,
    `build_sha = ${config.buildSha}`,
    `release_build = ${config.releaseBuild ? "1" : "0"}`,
    "",
  ].join("\n");
}

/** Write .buckconfig.ci at the repo root (gitignored). */
export function writeBuckConfigCi(root: string, config: BuckConfigCi): string {
  const path = join(root, ".buckconfig.ci");
  writeFileSync(path, buckConfigCiContents(config));
  return path;
}

export type Buck2CommandExecutor = ReleaseCommandExecutor;
export type HeadlessBuildSpawner = (
  command: string[],
  options?: Parameters<typeof spawnAsync>[1],
) => Promise<SpawnResult>;

async function runBuck2Build(
  root: string,
  target: string,
  env: NodeJS.ProcessEnv | undefined,
  executor: Buck2CommandExecutor | undefined,
  spawn: HeadlessBuildSpawner,
): Promise<string> {
  const args = [
    "buck2",
    "build",
    "--config-file",
    ".buckconfig.ci",
    "--show-output",
    target,
  ];
  const result = executor
    ? await executor(args, { cwd: root, env })
    : await spawn(args, {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "inherit",
      });
  if (result.code !== 0) {
    throw new Error(`buck2 build of ${target} failed with exit code ${result.code}`);
  }
  const outputPath = parseBuck2ShowOutput(result.stdout);
  // buck2 prints project-relative paths (buck-out/...); be robust to absolute
  // paths too (path.join concatenates instead of resetting on absolute args).
  const resolvedOutput = isAbsolute(outputPath) ? outputPath : join(root, outputPath);
  if (!existsSync(resolvedOutput)) {
    throw new Error(`buck2 build of ${target} produced no output at ${resolvedOutput}`);
  }
  return resolvedOutput;
}

/**
 * Build the unsigned headless archive + tar validator via Buck2 in release
 * mode and copy them to the release asset paths:
 *   target/release/headless/<asset>        (archive)
 *   target/release/pantoken-tar-validate   (validator binary, 0755)
 *
 * Writes .buckconfig.ci with version / build_sha / release_build=1 and passes
 * it via --config-file, so the embedded PANTOKEN_BUILD_SHA and the archive's
 * BUILD_SHA file agree (the smoke test asserts this).
 */
export interface HeadlessBuildResult {
  archivePath: string;
  validatorPath: string;
}

export async function buildViaBuck2(
  opts: {
    root: string;
    version: string;
    buildSha: string;
    outputDir: string;
    asset: string;
    /** Environment passed only to the Buck2 child processes. */
    env?: NodeJS.ProcessEnv;
    /** Optional capture/timing executor used by release-readiness. */
    executor?: Buck2CommandExecutor;
  },
  dependencies: { spawnAsync?: HeadlessBuildSpawner } = {},
): Promise<HeadlessBuildResult> {
  const { root, version, buildSha, outputDir, asset, env, executor } = opts;
  const spawn = dependencies.spawnAsync ?? spawnAsync;
  mkdirSync(outputDir, { recursive: true });
  writeBuckConfigCi(root, { version, buildSha, releaseBuild: true });

  const archiveOut = await runBuck2Build(
    root,
    "//:pantoken_headless_unsigned",
    env,
    executor,
    spawn,
  );
  const archivePath = join(outputDir, asset);
  copyFileSync(archiveOut, archivePath);

  const validatorOut = await runBuck2Build(
    root,
    "//server/pantoken-tar-validate:pantoken_tar_validate",
    env,
    executor,
    spawn,
  );
  const validatorPath = join(root, "target", "release", "pantoken-tar-validate");
  copyFileSync(validatorOut, validatorPath);
  chmodSync(validatorPath, 0o755);

  return { archivePath, validatorPath };
}
