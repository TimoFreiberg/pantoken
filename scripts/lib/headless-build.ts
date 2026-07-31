// Build the headless release archive + tar validator via Buck2.
// Extracted from scripts/headless/build.ts so it can be unit-tested without
// triggering the build script's top-level boot code.

import { chmodSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnAsync } from "./node-compat.js";
import { parseBuck2ShowOutput } from "./build-server.js";

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

async function runBuck2Build(root: string, target: string): Promise<string> {
  const args = [
    "buck2",
    "build",
    "--config-file",
    ".buckconfig.ci",
    "--show-output",
    target,
  ];
  const result = await spawnAsync(args, {
    cwd: root,
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
export async function buildViaBuck2(opts: {
  root: string;
  version: string;
  buildSha: string;
  outputDir: string;
  asset: string;
}): Promise<string> {
  const { root, version, buildSha, outputDir, asset } = opts;
  writeBuckConfigCi(root, { version, buildSha, releaseBuild: true });

  const archiveOut = await runBuck2Build(root, "//:pantoken_headless_unsigned");
  const archivePath = join(outputDir, asset);
  copyFileSync(archiveOut, archivePath);

  const validatorOut = await runBuck2Build(
    root,
    "//server-rs/pantoken-tar-validate:pantoken_tar_validate",
  );
  const validatorPath = join(root, "target", "release", "pantoken-tar-validate");
  copyFileSync(validatorOut, validatorPath);
  chmodSync(validatorPath, 0o755);

  return archivePath;
}
