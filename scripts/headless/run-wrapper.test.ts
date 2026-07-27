import { describe, expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAsync } from "../lib/node-compat.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const wrapper = join(SCRIPT_DIR, "../../deploy/run.sh");

function fixture(name: string, output: string): { home: string; version: string } {
  const home = mkdtempSync(join(tmpdir(), `pantoken-wrapper-${name}-`));
  const version = join(home, "pantoken versions", name);
  mkdirSync(join(version, "bin"), { recursive: true });
  mkdirSync(join(version, "client-dist"), { recursive: true });
  writeFileSync(join(version, "client-dist", "index.html"), `<html>${name}</html>`);
  writeFileSync(join(version, "run.sh"), statSync(wrapper).size ? readFileSync(wrapper) : "", { mode: 0o755 });
  chmodSync(join(version, "run.sh"), 0o755);
  writeFileSync(
    join(version, "bin", "pantoken-server"),
    `#!/bin/sh\nprintf '%s\\n' '${output}'\n`,
  );
  chmodSync(join(version, "bin", "pantoken-server"), 0o755);
  mkdirSync(join(home, ".local", "share", "pantoken"), { recursive: true });
  writeFileSync(
    join(home, ".local", "share", "pantoken", "pantoken.env"),
    "PANTOKEN_TOKEN=test-token\nPANTOKEN_VAPID_SUBJECT=mailto:test@example.com\n",
    { mode: 0o600 },
  );
  symlinkSync(version, join(home, "pantoken-live"));
  return { home, version };
}

describe("release runtime wrapper", () => {
  test("resolves the active live symlink and path with spaces", async () => {
    const f = fixture("one", "selected-one");
    const result = await spawnAsync([join(f.home, "pantoken-live", "run.sh")], { env: { ...process.env, HOME: f.home }, stdout: "pipe", stderr: "pipe" });
    expect(result.stdout.trim()).toBe("selected-one");
    expect(result.code, result.stderr).toBe(0);
  });

  test("rejects inherited data-dir override and unsafe env syntax", async () => {
    const f = fixture("unsafe", "never");
    writeFileSync(join(f.home, ".local", "share", "pantoken", "pantoken.env"), "PANTOKEN_DATA_DIR=/tmp/escape\n", { mode: 0o600 });
    const result = await spawnAsync([wrapper], { env: { ...process.env, HOME: f.home, PANTOKEN_DATA_DIR: "/tmp/inherited" }, stderr: "pipe" });
    expect(result.code).not.toBe(0);
  });
});
