#!/usr/bin/env tsx
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { spawnAsync, isMain } from "../lib/node-compat.js";
import { runReleaseReadiness } from "../release-readiness.js";

export interface ReleasePlan { current: string; next: string; tag: string; buildSha: string; target?: string; }
export interface ReleaseRunner { capture(command: string[], cwd?: string): Promise<string>; run?(command: string[], cwd?: string): Promise<void>; }
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function bumpVersion(current: string, kind: "patch" | "minor" | "major"): string {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`unparseable version '${current}'`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
export function computeReleasePlan(current: string, next: string, buildSha: string, target?: string): ReleasePlan {
  if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`implausible version '${next}'`);
  if (!/^[0-9a-f]{40}$/.test(buildSha)) throw new Error(`invalid build SHA '${buildSha}'`);
  return { current, next, tag: `v${next}`, buildSha, target };
}

async function defaultCapture(command: string[], cwd = defaultRoot): Promise<string> {
  const result = await spawnAsync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.code !== 0) throw new Error(`\`${command.join(" ")}\` failed:\n${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}
const defaultRunner: ReleaseRunner = { capture: defaultCapture };

export async function executeRelease(plan: ReleasePlan, options: { root?: string; dryRun?: boolean; noPush?: boolean; runner?: ReleaseRunner; readiness?: typeof runReleaseReadiness } = {}): Promise<void> {
  const root = options.root ?? defaultRoot;
  const runner = options.runner ?? defaultRunner;
  const confPath = join(root, "desktop", "tauri.conf.json");
  const cargoPath = join(root, "desktop", "Cargo.toml");
  if (options.dryRun) { console.log(`[dry-run] would verify ${plan.tag}, bump, commit, tag${options.noPush ? " (no push)" : ", and push"}`); return; }
  const dirty = (await runner.capture(["jj", "diff", "--summary"], root)).trim();
  if (dirty) throw new Error(`working copy is not empty — commit or abandon first:\n${dirty}`);
  if ((await runner.capture(["git", "tag", "-l", plan.tag], root)).trim()) throw new Error(`tag ${plan.tag} already exists locally`);
  await (options.readiness ?? runReleaseReadiness)({ root, version: plan.next, buildSha: plan.buildSha, target: plan.target });
  const confText = await readFile(confPath, "utf8");
  const cargoText = await readFile(cargoPath, "utf8");
  const confNeedle = `"version": "${plan.current}"`;
  const cargoNeedle = `version = "${plan.current}"`;
  if (!confText.includes(confNeedle) || !cargoText.includes(cargoNeedle)) throw new Error("could not find current version in release metadata");
  await writeFile(confPath, confText.replace(confNeedle, `"version": "${plan.next}"`));
  await writeFile(cargoPath, cargoText.replace(cargoNeedle, `version = "${plan.next}"`));
  await runner.capture(["cargo", "update", "--workspace"], join(root, "desktop"));
  await runner.capture(["jj", "commit", "desktop/tauri.conf.json", "desktop/Cargo.toml", "Cargo.lock", "-m", `Release ${plan.tag}`], root);
  const commit = (await runner.capture(["jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id"], root)).trim();
  await runner.capture(["git", "tag", plan.tag, commit], root);
  if (options.noPush) { console.log(`--no-push: jj bookmark move main --to ${commit.slice(0, 12)}`); return; }
  await runner.capture(["jj", "bookmark", "move", "main", "--to", commit], root);
  await runner.capture(["jj", "git", "push", "--bookmark", "main"], root);
  await runner.capture(["git", "push", "origin", plan.tag], root);
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const root = defaultRoot;
  const conf = JSON.parse(await readFile(join(root, "desktop", "tauri.conf.json"), "utf8")) as { version?: string };
  const current = conf.version ?? "";
  const idx = argv.indexOf("--version");
  const next = idx >= 0 ? (argv[idx + 1] ?? (() => { throw new Error("--version needs a value"); })()) : bumpVersion(current, argv.includes("--major") ? "major" : argv.includes("--minor") ? "minor" : "patch");
  const dryRun = argv.includes("--dry-run");
  const sha = dryRun ? "0".repeat(40) : (await defaultCapture(["git", "rev-parse", "HEAD"], root)).trim();
  try { await executeRelease(computeReleasePlan(current, next, sha), { root, dryRun, noPush: argv.includes("--no-push") }); }
  catch (error) { console.error(`release: ${error instanceof Error ? error.message : error}`); process.exit(1); }
}
