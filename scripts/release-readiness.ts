import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnAsync, isMain } from "./lib/node-compat.js";
import { buildViaBuck2, type HeadlessBuildResult } from "./lib/headless-build.js";
import { HEADLESS_TARGETS, headlessTargetForTriple } from "./desktop/release-constants.js";

export interface ReleaseReadinessOptions {
  root: string;
  version: string;
  buildSha: string;
  target?: string;
  runGate?: boolean;
  run?: CommandRunner;
  build?: typeof buildViaBuck2;
}
export interface ReleaseReadinessResult { archivePath: string; validatorPath: string; }
export type CommandRunner = (command: string[], options: { cwd: string; env?: Record<string, string> }) => Promise<void>;

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

function nativeTarget(): string {
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  throw new Error(`release readiness is unavailable on ${process.platform}/${process.arch}`);
}
export function validateReadinessInputs(version: string, buildSha: string, target = nativeTarget()): string {
  if (!VERSION.test(version)) throw new Error(`invalid release version '${version}'`);
  if (!SHA.test(buildSha)) throw new Error(`invalid build SHA '${buildSha}'`);
  const selected = headlessTargetForTriple(target);
  if (target !== nativeTarget()) throw new Error(`target ${target} is unavailable on this host`);
  return selected.targetTriple;
}

const realRun: CommandRunner = async (command, options) => {
  const result = await spawnAsync(command, { cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : undefined, stdout: "inherit", stderr: "inherit" });
  if ((result.code ?? 1) !== 0) throw new Error(`${command.join(" ")} failed with exit code ${result.code}`);
};

export async function runReleaseReadiness(options: ReleaseReadinessOptions): Promise<ReleaseReadinessResult> {
  const targetTriple = validateReadinessInputs(options.version, options.buildSha, options.target);
  const run = options.run ?? realRun;
  const build = options.build ?? buildViaBuck2;
  const target = headlessTargetForTriple(targetTriple);
  const outputDir = join(options.root, "target", "release", "headless");
  if (options.runGate !== false) await run(["just", "ci-local"], { cwd: options.root });
  const built: HeadlessBuildResult = await build({ root: options.root, version: options.version, buildSha: options.buildSha, outputDir, asset: target.asset });
  await run(["just", "validate-archive-rs-ci"], { cwd: options.root });
  await run(["pnpm", "exec", "tsx", "scripts/headless/validate-artifact.ts", built.archivePath, "--version", options.version], { cwd: options.root, env: { PANTOKEN_TAR_VALIDATOR: built.validatorPath, PANTOKEN_UPDATE_TEST_MODE: "1" } });
  const extracted = mkdtempSync(join(tmpdir(), "pantoken-readiness-"));
  try {
    await run(["tar", "xzf", built.archivePath, "-C", extracted], { cwd: options.root });
    await run(["pnpm", "exec", "tsx", "scripts/headless/smoke-test.ts", extracted], { cwd: options.root });
  } finally { rmSync(extracted, { recursive: true, force: true }); }
  if (!existsSync(built.archivePath) || !existsSync(built.validatorPath)) throw new Error("readiness build did not return existing paths");
  return built;
}

export function defaultReadinessTarget(): string { return nativeTarget(); }
export { HEADLESS_TARGETS };

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const conf = JSON.parse(await readFile(join(root, "desktop", "tauri.conf.json"), "utf8")) as { version?: string };
  const current = conf.version ?? "";
  const suppliedVersion = value("--version");
  const version = suppliedVersion ?? (() => {
    const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) throw new Error(`cannot derive next version from '${current}'`);
    return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
  })();
  const suppliedSha = value("--build-sha");
  let buildSha = suppliedSha;
  if (!buildSha) {
    const git = await spawnAsync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    buildSha = git.stdout.trim();
  }
  const target = value("--target") ?? defaultReadinessTarget();
  try {
    const result = await runReleaseReadiness({ root, version, buildSha, target });
    console.log(`release readiness passed: ${result.archivePath}`);
  } catch (error) {
    console.error(`release-readiness: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
