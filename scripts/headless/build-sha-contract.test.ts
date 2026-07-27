import { describe, expect, test } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const manifest = join(SCRIPT_DIR, "../../server-rs/pantoken-server/Cargo.toml");

describe("release build SHA contract", () => {
  test("server crate wires the checked-in build script", async () => {
    const text = await readFile(manifest, "utf8");
    expect(text).toContain('build = "build.rs"');
    const build = await readFile(join(SCRIPT_DIR, "../../server-rs/pantoken-server/build.rs"), "utf8");
    expect(build).toContain("PANTOKEN_BUILD_SHA");
    expect(build).toContain("exactly 40 lowercase hexadecimal");
  });
});
