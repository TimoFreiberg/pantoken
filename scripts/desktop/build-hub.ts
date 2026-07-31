#!/usr/bin/env tsx
// build-hub.ts — compile the Rust pantoken server into a binary for the bundled
// desktop app.
//
// The output lands in desktop/binaries/pantoken-server-<target-triple> — the
// target-triple suffix is Tauri's externalBin convention (the bundler strips it
// and ships the binary as Contents/MacOS/pantoken-server). At runtime the binary
// only needs the external tools the hub always shelled out to (polytoken,
// git/jj) plus PANTOKEN_CLIENT_DIST pointing at a built client bundle (in the
// .app: the client-dist resource).
//
// Run from anywhere: `tsx scripts/desktop/build-hub.ts`. Used as the Tauri
// beforeDevCommand/beforeBuildCommand (desktop/tauri.conf.json) — dev
// needs the file to exist because tauri-build stages externalBin next to the
// dev binary and errors when it's missing, even though dev never spawns it.
//
// Pass --debug to build without --release (faster, unoptimized). CI's desktop
// lint job uses this — tauri-build's copy_binaries just needs the file to exist,
// not a real release binary. Dev and release-prepare keep the default --release.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain, spawnAsync } from "../lib/node-compat.js";
import { parseBuck2ShowOutput } from "../lib/build-server.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Rust-style target triple for the host, matching what `tauri build` expects
 *  for externalBin lookup. Extend when a new host platform actually ships. */
export function hostTriple(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const map: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
  };
  const triple = map[`${platform}-${arch}`];
  if (!triple) {
    throw new Error(
      `no target triple mapping for ${platform}-${arch} — add one to build-hub.ts`,
    );
  }
  return triple;
}

if (isMain(import.meta.url)) {
  const outDir = join(repoRoot, "desktop", "binaries");
  mkdirSync(outDir, { recursive: true });
  // tauri.conf.json maps ../client/dist as a bundle resource; guarantee the dir
  // exists so a fresh checkout can `tauri dev` before any client build.
  mkdirSync(join(repoRoot, "client", "dist"), { recursive: true });

  // Build the Rust server binary via Buck2.
  // The Tauri externalBin convention expects the binary at
  // desktop/binaries/pantoken-server-<target-triple>.
  // .buckconfig.local is auto-read by buck2 (no --config-file flag needed).
  const triple = hostTriple();

  const buck2Args = ["buck2", "build", "--show-output", "//server/pantoken-server:pantoken_server"];
  const result = await spawnAsync(buck2Args, {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.code !== 0) {
    console.error(`buck2 build failed with exit code ${result.code}`);
    process.exit(result.code ?? 1);
  }
  // buck2 prints the output path relative to the project root; resolve it
  // against repoRoot so the exists/copy below work even when this script runs
  // from a different cwd (tauri runs beforeBuildCommand from desktop/).
  const built = resolve(repoRoot, parseBuck2ShowOutput(result.stdout));
  const outfile = join(outDir, `pantoken-server-${triple}`);
  if (!existsSync(built)) {
    console.error(`buck2 build succeeded but ${built} is missing`);
    process.exit(1);
  }
  copyFileSync(built, outfile);
  const size = (statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`server compiled (buck2) → ${outfile} (${size} MB)`);
}
