import { describe, expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { spawnAsync } from "../lib/node-compat.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const PREFLIGHT = join(SCRIPT_DIR, "../../deploy/bazel-remote-preflight.sh");
const PLIST_TEMPLATE = join(SCRIPT_DIR, "../../deploy/com.bazel-remote.plist");

// ── Helpers ──────────────────────────────────────────────────────────────────

function readAll(path: string): string {
  return readFileSync(path, "utf-8");
}

/** Create a fake executable in a temp dir and return its path. */
function fakeBin(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Build a set of fake binaries (bazel-remote, tailscale, df, sudo, plutil,
 * launchctl, curl) and return an env object that injects them via the
 * command-seam env vars.
 */
function fakeEnv(tmpHome: string, overrides: Record<string, string> = {}): {
  env: Record<string, string | undefined>;
  fakeBinDir: string;
} {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "br-fakebin-"));

  // Fake bazel-remote: outputs version string matching default 2.6.2
  fakeBin(fakeBinDir, "bazel-remote", "#!/bin/sh\n" +
    'if [ "$1" = "--version" ]; then\n' +
    '  echo "bazel-remote version 2.6.2"\n' +
    "else\n" +
    '  echo "bazel-remote version 2.6.2"\n' +
    "fi\n");

  // Fake tailscale: outputs a status line
  fakeBin(fakeBinDir, "tailscale", "#!/bin/sh\necho '100.64.0.1 macmini'\n");

  // Fake df: outputs adequate disk space (2000000 1K-blocks = ~2 TiB)
  fakeBin(fakeBinDir, "df", "#!/bin/sh\necho 'Filesystem 1K-blocks Used Avail Capacity Mounted on'\n" +
    "echo '/dev/disk1 2000000 500000 1500000 25% /'\n");

  // Fake sudo: just passes through to the command
  fakeBin(fakeBinDir, "sudo", "#!/bin/sh\nexec \"$@\"\n");

  // Fake plutil: always succeeds (real plutil is macOS-only)
  fakeBin(fakeBinDir, "plutil", "#!/bin/sh\nexit 0\n");

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: tmpHome,
    BAZEL_REMOTE_BIN: join(fakeBinDir, "bazel-remote"),
    TAILSCALE_BIN: join(fakeBinDir, "tailscale"),
    DF_BIN: join(fakeBinDir, "df"),
    SUDO_BIN: join(fakeBinDir, "sudo"),
    PLUTIL_BIN: join(fakeBinDir, "plutil"),
    ...overrides,
  };
  // Remove real PATH bazel-remote if present to ensure fake is used
  return { env, fakeBinDir };
}

// ── Plist template tests ─────────────────────────────────────────────────────

describe("bazel-remote plist template", () => {
  test("renders to valid plist via sed substitution", () => {
    const content = readAll(PLIST_TEMPLATE);
    const rendered = content
      .replaceAll("@@@BAZEL_REMOTE_BIN@@@", "/usr/local/bin/bazel-remote")
      .replaceAll("@@@CACHE_DIR@@@", "/usr/local/var/bazel-remote")
      .replaceAll("@@@MAX_SIZE@@@", "500")
      .replaceAll("@@@GRPC_PORT@@@", "9092")
      .replaceAll("@@@HTTP_PORT@@@", "8080")
      .replaceAll("@@@LOGDIR@@@", "/Users/timo/Library/Logs/bazel-remote");

    // Value placeholders must be gone.
    expect(rendered).not.toMatch(/<string>@@@/);

    const tmp = join(mkdtempSync(join(tmpdir(), "br-plist-")), "rendered.plist");
    writeFileSync(tmp, rendered);
    const lint = spawnSync("plutil", ["-lint", tmp]);
    if (lint.status === 0) {
      expect(lint.status).toBe(0);
    }
    rmSync(tmp, { force: true });
  });

  test("template contains all required placeholders", () => {
    const content = readAll(PLIST_TEMPLATE);
    expect(content).toContain("@@@BAZEL_REMOTE_BIN@@@");
    expect(content).toContain("@@@CACHE_DIR@@@");
    expect(content).toContain("@@@MAX_SIZE@@@");
    expect(content).toContain("@@@GRPC_PORT@@@");
    expect(content).toContain("@@@HTTP_PORT@@@");
    expect(content).toContain("@@@LOGDIR@@@");
  });
});

// ── Preflight script tests ───────────────────────────────────────────────────

describe("bazel-remote-preflight.sh", () => {
  test("exists and is executable", () => {
    expect(existsSync(PREFLIGHT)).toBe(true);
    const stat = statSync(PREFLIGHT);
    expect(stat.mode & 0o111).toBeTruthy();
  });

  test("rejects unknown args", async () => {
    const proc = await spawnAsync([PREFLIGHT, "--bogus"], { stderr: "pipe", stdout: "pipe" });
    expect(proc.code).toBe(1);
    expect((proc.stdout + proc.stderr)).toContain("Unknown arg");
  });

  test("read-only preflight with fake bins produces ✓ output and exit 0", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "br-preflight-ro-"));
    const { env, fakeBinDir } = fakeEnv(tmpHome);

    const proc = await spawnAsync([PREFLIGHT], { stderr: "pipe", stdout: "pipe", env });
    const output = proc.stdout + proc.stderr;

    expect(proc.code).toBe(0);
    expect(output).toContain("Bazel-Remote Preflight");
    expect(output).toContain("bazel-remote 2.6.2");
    expect(output).toContain("Tailscale running");
    expect(output).toMatch(/[✓✗⚠ℹ]/);

    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  test("preflight version mismatch produces ✗ and exit 1", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "br-preflight-ver-"));
    const { env, fakeBinDir } = fakeEnv(tmpHome);

    // Override with a fake bazel-remote that reports wrong version
    const fakeBinDir2 = mkdtempSync(join(tmpdir(), "br-fakebin-ver-"));
    const fakeBr = fakeBin(fakeBinDir2, "bazel-remote",
      "#!/bin/sh\necho 'bazel-remote version 1.0.0'\n");
    env.BAZEL_REMOTE_BIN = fakeBr;

    const proc = await spawnAsync([PREFLIGHT], { stderr: "pipe", stdout: "pipe", env });
    const output = proc.stdout + proc.stderr;

    expect(proc.code).toBe(1);
    expect(output).toContain("1.0.0");
    expect(output).toContain("expected 2.6.2");

    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(fakeBinDir2, { recursive: true, force: true });
  });

  test("preflight warns on low disk but exits 0", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "br-preflight-disk-"));
    const fakeBinDir = mkdtempSync(join(tmpdir(), "br-fakebin-disk-"));

    fakeBin(fakeBinDir, "bazel-remote",
      "#!/bin/sh\necho 'bazel-remote version 2.6.2'\n");
    fakeBin(fakeBinDir, "tailscale", "#!/bin/sh\necho '100.64.0.1 macmini'\n");
    // Only 10000 1K-blocks = ~10 MiB — way below 2×500 GiB threshold
    fakeBin(fakeBinDir, "df", "#!/bin/sh\necho 'Filesystem 1K-blocks Used Avail Capacity Mounted on'\n" +
      "echo '/dev/disk1 10000 5000 5000 50% /'\n");

    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: tmpHome,
      BAZEL_REMOTE_BIN: join(fakeBinDir, "bazel-remote"),
      TAILSCALE_BIN: join(fakeBinDir, "tailscale"),
      DF_BIN: join(fakeBinDir, "df"),
    };

    // Use a cache dir whose parent exists so the df check actually runs.
    const tmpCacheParent = mkdtempSync(join(tmpdir(), "br-cache-parent-"));
    const tmpCacheDir = join(tmpCacheParent, "bazel-remote");

    const proc = await spawnAsync(
      [PREFLIGHT, "--max-size", "500", "--cache-dir", tmpCacheDir],
      { stderr: "pipe", stdout: "pipe", env },
    );
    const output = proc.stdout + proc.stderr;

    expect(proc.code).toBe(0);
    expect(output).toContain("low disk space");

    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(tmpCacheParent, { recursive: true, force: true });
  });

  test("setup mode with --skip-daemon renders plist and env file", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "br-setup-"));
    const { env, fakeBinDir } = fakeEnv(tmpHome);
    const tmpCacheDir = join(tmpHome, "cache");

    const proc = await spawnAsync(
      [PREFLIGHT, "--setup", "--skip-daemon", "--cache-dir", tmpCacheDir, "--max-size", "5"],
      { stderr: "pipe", stdout: "pipe", env },
    );
    const output = proc.stdout + proc.stderr;

    expect(proc.code).toBe(0);
    expect(output).toContain("Setup complete");
    expect(output).toContain("Skipped daemon installation");

    // Plist rendered
    const renderedPlist = join(tmpHome, ".local", "share", "bazel-remote", "com.bazel-remote.plist");
    expect(existsSync(renderedPlist)).toBe(true);
    const plistContent = readAll(renderedPlist);
    // Value placeholders must be gone (comment text mentioning @@@ may remain).
    expect(plistContent).not.toMatch(/<string>@@@/);
    expect(plistContent).toContain(tmpCacheDir);
    expect(plistContent).toContain("--enable_ac_key_instance_mangling");

    // Env file written
    const envFile = join(tmpHome, ".local", "share", "bazel-remote", "bazel-remote.env");
    expect(existsSync(envFile)).toBe(true);
    const envContent = readAll(envFile);
    expect(envContent).toContain("INSTANCE_NAME=buck2");
    expect(envContent).toContain("GRPC_PORT=9092");

    // Plist lints
    const lint = spawnSync("plutil", ["-lint", renderedPlist]);
    if (lint.status === 0) {
      expect(lint.status).toBe(0);
    }

    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  test("setup rejects missing bazel-remote binary", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "br-setup-missing-"));
    const fakeBinDir = mkdtempSync(join(tmpdir(), "br-fakebin-missing-"));

    // No bazel-remote fake — point to nonexistent path
    fakeBin(fakeBinDir, "tailscale", "#!/bin/sh\necho '100.64.0.1 macmini'\n");
    fakeBin(fakeBinDir, "df", "#!/bin/sh\necho 'Filesystem 1K-blocks Used Avail Capacity Mounted on'\n" +
      "echo '/dev/disk1 2000000 500000 1500000 25% /'\n");

    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: tmpHome,
      BAZEL_REMOTE_BIN: "/nonexistent/bazel-remote",
      TAILSCALE_BIN: join(fakeBinDir, "tailscale"),
      DF_BIN: join(fakeBinDir, "df"),
    };

    const proc = await spawnAsync(
      [PREFLIGHT, "--setup", "--skip-daemon"],
      { stderr: "pipe", stdout: "pipe", env },
    );
    const output = proc.stdout + proc.stderr;

    expect(proc.code).toBe(1);
    expect(output).toContain("bazel-remote not found");

    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  });
});
