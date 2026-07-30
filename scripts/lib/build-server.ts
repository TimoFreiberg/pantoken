// Build-system selection logic for the dev server.
// Extracted from scripts/dev.ts so it can be unit-tested without triggering
// the dev server's top-level boot code.
//
// PANTOKEN_BUILD_SYSTEM=buck2 (default) builds the server via Buck2 and spawns
// the binary directly. PANTOKEN_BUILD_SYSTEM=cargo falls back to `cargo run`.

import { join, resolve, isAbsolute } from "node:path";
import { spawnAsync } from "./node-compat.js";

/** Resolve Cargo's effective target directory (mirrors build-hub.ts logic). */
export function cargoTargetDir(
  repoRoot: string,
  targetDir = process.env.CARGO_TARGET_DIR,
): string {
  return targetDir
    ? isAbsolute(targetDir)
      ? resolve(targetDir)
      : resolve(join(repoRoot, "server-rs"), targetDir)
    : join(repoRoot, "target");
}

/** Parse `buck2 build --show-output` stdout to extract the binary path.
 *  Output format: `//label buck-out/path/to/binary` */
export function parseBuck2ShowOutput(stdout: string): string {
  const lines = stdout.trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) throw new Error("buck2 build --show-output produced no output");
  const parts = last.split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`unexpected buck2 --show-output format: "${last}"`);
  }
  return parts[1]!;
}

/** Build the pantoken-server binary and return its path.
 *  Uses buck2 by default; PANTOKEN_BUILD_SYSTEM=cargo falls back to cargo. */
export async function resolveServerBinary(
  buildSystem: string,
  root: string,
): Promise<string> {
  if (buildSystem === "cargo") {
    // Cargo fallback: build then return the debug binary path
    const cargoRoot = join(root, "server-rs");
    const targetDir = cargoTargetDir(root);
    const result = await spawnAsync(
      ["cargo", "build", "--bin", "pantoken-server"],
      {
        cwd: cargoRoot,
        env: { ...process.env, CARGO_TARGET_DIR: targetDir },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if (result.code !== 0) {
      throw new Error(`cargo build failed with exit code ${result.code}`);
    }
    return join(targetDir, "debug", "pantoken-server");
  }

  // Buck2 path: build with --show-output, parse the binary path.
  // .buckconfig.local is auto-read by buck2 (no --config-file needed).
  const args = ["buck2", "build", "--show-output", "//server-rs/pantoken-server:pantoken_server"];
  const result = await spawnAsync(args, {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.code !== 0) {
    throw new Error(`buck2 build failed with exit code ${result.code}`);
  }
  return parseBuck2ShowOutput(result.stdout);
}
