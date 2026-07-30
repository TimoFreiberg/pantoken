// Build the pantoken-server binary via Buck2 and return its path.
// Extracted from scripts/dev.ts so it can be unit-tested without triggering
// the dev server's top-level boot code.

import { resolve } from "node:path";
import { spawnAsync } from "./node-compat.js";

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

/** Build the pantoken-server binary via Buck2 and return its path.
 *  .buckconfig.local is auto-read by buck2 (no --config-file needed). */
export async function resolveServerBinary(root: string): Promise<string> {
  const args = ["buck2", "build", "--show-output", "//server-rs/pantoken-server:pantoken_server"];
  const result = await spawnAsync(args, {
    cwd: resolve(root),
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.code !== 0) {
    throw new Error(`buck2 build failed with exit code ${result.code}`);
  }
  return parseBuck2ShowOutput(result.stdout);
}
