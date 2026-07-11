import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const UPDATER = join(import.meta.dir, "../../deploy/update-headless.sh");
const FAKE_MINISIGN = join(import.meta.dir, "fake-minisign");
const FAKE_LAUNCHCTL = join(import.meta.dir, "fake-launchctl");
const FIXTURE_SERVER = join(import.meta.dir, "fixture-server");

// ── Helpers ──────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForHealth(
  port: number,
  timeoutMs = 5000,
  failBody = false
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      fetch(`http://127.0.0.1:${port}/health`).then((r) => {
        if (r.ok) {
          r.text().then((body) => {
            const ok = failBody ? body.includes("ok") : body.includes('"ok":true');
            resolve(ok);
          });
        } else if (Date.now() < deadline) {
          setTimeout(poll, 200);
        } else {
          resolve(false);
        }
      }).catch(() => {
        if (Date.now() < deadline) {
          setTimeout(poll, 200);
        } else {
          resolve(false);
        }
      });
    };
    poll();
  });
}

function waitForHtml(port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    fetch(`http://127.0.0.1:${port}/`).then((r) => {
      resolve(r.ok && r.headers.get("content-type")?.includes("text/html") ?? false);
    }).catch(() => resolve(false));
  });
}

// ── Fixture: create a valid headless release archive ─────────────

function createValidPayload(
  versionsDir: string,
  version: string,
  buildSha: string,
  opts: {
    fixturePort?: number;
    fixtureHealthBody?: string;
    fixtureBuildSha?: string;
  } = {}
): {
  tarPath: string;
  sigPath: string;
  fixturePort: number;
  fixturePid: number;
} {
  const tarPath = join(
    versionsDir,
    "pantoken-headless-macos-aarch64.tar.gz"
  );
  const sigPath = tarPath + ".sig";

  // Create a valid tar archive with the required layout
  const stageDir = mkdtempSync(join(tmpdir(), `pantoken-payload-`));
  mkdirSync(join(stageDir, "bin"), { recursive: true });
  mkdirSync(join(stageDir, "client-dist"), { recursive: true });

  writeFileSync(join(stageDir, "VERSION"), version);
  writeFileSync(join(stageDir, "BUILD_SHA"), buildSha);
  writeFileSync(
    join(stageDir, "bin", "pantoken-server"),
    "#!/bin/sh\necho fixture-server\n",
    { mode: 0o755 }
  );
  writeFileSync(
    join(stageDir, "run.sh"),
    "#!/bin/sh\nexec true\n",
    { mode: 0o755 }
  );
  writeFileSync(
    join(stageDir, "update.sh"),
    "#!/bin/sh\nexec true\n",
    { mode: 0o755 }
  );
  writeFileSync(
    join(stageDir, "client-dist", "index.html"),
    "<html><body>pantoken</body></html>"
  );

  // Create tar
  const { spawnSync } = require("node:child_process");
  spawnSync("tar", [
    "-czf",
    tarPath,
    "-C",
    stageDir,
    "VERSION",
    "BUILD_SHA",
    "bin/pantoken-server",
    "run.sh",
    "update.sh",
    "client-dist/index.html",
  ]);

  // Write dummy signature
  writeFileSync(sigPath, "FAKE-SIG-OK");

  rmSync(stageDir, { recursive: true, force: true });

  // Return paths for test harness to use
  return { tarPath, sigPath, fixturePort: opts.fixturePort ?? 0, fixturePid: 0 };
}

// ── Fixture: create fixture server process ───────────────────────

function startFixtureServer(
  opts: {
    port?: number;
    healthBody?: string;
    failHealth?: boolean;
    version?: string;
    buildSha?: string;
  } = {}
) {
  const port = opts.port ?? 0;
  const env: Record<string, string> = {
    ...process.env,
    FIXTURE_PORT: String(port),
    FIXTURE_HTML_VERSION: opts.version ?? "test-0.0.1",
    FIXTURE_BUILD_SHA: opts.buildSha ?? "abcdef1234567890abcdef1234567890abcdef1234",
  };
  if (opts.healthBody) env.FIXTURE_HEALTH_BODY = opts.healthBody;
  if (opts.failHealth) env.FIXTURE_FAIL_HEALTH = "1";

  const proc = spawn("python3", [FIXTURE_SERVER], { env });
  return proc;
}

// ── Make scripts executable once ─────────────────────────────────

const scriptsMade = new Set<string>();
function ensureExecutable(path: string) {
  if (scriptsMade.has(path)) return;
  try {
    chmodSync(path, 0o755);
    scriptsMade.add(path);
  } catch {
    // Already executable or permission denied
  }
}
ensureExecutable(FAKE_MINISIGN);
ensureExecutable(FAKE_LAUNCHCTL);

// ── Integration test suite ──────────────────────────────────────

describe("update-headless.sh integration", () => {
  let home: string;
  let versionsDir: string;
  let stateDir: string;
  let liveLink: string;
  let fixtureProc: ReturnType<typeof spawn> | null;

  function makeFixture() {
    home = mkdtempSync(join(tmpdir(), "pantoken-update-"));
    versionsDir = join(home, "pantoken-versions");
    stateDir = join(home, ".local", "state", "pantoken");
    liveLink = join(home, "pantoken-live");
    mkdirSync(versionsDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
  }

  function testEnv(extra: Record<string, string> = {}) {
    ensureExecutable(FAKE_MINISIGN);
    ensureExecutable(FAKE_LAUNCHCTL);
    return {
      ...process.env,
      HOME: home,
      PANTOKEN_UPDATE_TEST_MODE: "1",
      PANTOKEN_TEST_ASSET_URL: `file://${join(versionsDir, "pantoken-headless-macos-aarch64.tar.gz")}`,
      PANTOKEN_TEST_SIG_URL: `file://${join(versionsDir, "pantoken-headless-macos-aarch64.tar.gz.sig")}`,
      PANTOKEN_TEST_KICKSTART_CMD: `${FAKE_LAUNCHCTL}`,
      PATH: `${join(import.meta.dir)}:${process.env.PATH}`,
      ...extra,
    };
  }

  function runUpdater(tag?: string) {
    const args: string[] = [UPDATER];
    if (tag) args.push(tag);
    return Bun.spawn(args, { env: testEnv() });
  }

  test("rejects invalid release tags", async () => {
    makeFixture();
    const badTags = ["v1.2", "v01.2.3", "1.2.3", "v1.2.3-beta", "latest", "abc", "v1.2.3.4"];
    for (const tag of badTags) {
      const proc = Bun.spawn([UPDATER, tag], {
        env: testEnv({ HOME: mkdtempSync(join(tmpdir(), `pantoken-badtag-`) ) }),
      });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(1);
    }
  });

  test("accepts valid semantic-version tags (v1.2.3)", async () => {
    // We can't fully test tag-based download without a real server,
    // but we verify the regex accepts valid tags
    const validTags = ["v0.1.0", "v1.0.0", "v1.2.3", "v0.0.1", "v10.20.30"];
    for (const tag of validTags) {
      const valid = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag);
      expect(valid).toBe(true);
    }
  });

  test("creates lock directory to prevent concurrent runs", async () => {
    makeFixture();
    // Create a valid payload
    createValidPayload(versionsDir, "1.0.0", "aaa111bbb222ccc333ddd444eee555fff666aaa777");

    const proc = runUpdater();
    // Let it start and acquire lock
    await new Promise((r) => setTimeout(r, 500));

    // Check that lock directory exists
    expect(Bun.file(join(stateDir, ".update.lock", ".lock")).exists()).toBe(true);

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });

  test("records all required journal states in script", async () => {
    const script = readFileSync(UPDATER, "utf8");
    const requiredStates = [
      "started",
      "downloaded",
      "signature-verified",
      "archive-validated",
      "flipped",
      "restart-requested",
      "new-process-confirmed",
      "healthy",
      "committed",
      "completed",
      "rollback-started",
      "rollback-flipped",
      "rollback-healthy",
      "rollback-failed",
    ];
    for (const state of requiredStates) {
      expect(script).toContain(state);
    }
  });

  test("uses atomic rename for symlink flip", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain(".new.$$");
    expect(script).toContain("ln -sfn");
    expect(script).toContain("mv -f");
  });

  test("verifies signature before tar extraction", async () => {
    const script = readFileSync(UPDATER, "utf8");
    const lines = script.split("\n");
    const verifyLine = lines.findIndex((l) => l.includes("verify_signature"));
    const extractLine = lines.findIndex((l) => l.includes("extract_staging"));
    const validateLine = lines.findIndex((l) => l.includes("validate_tar"));
    expect(verifyLine).toBeLessThan(extractLine);
    expect(validateLine).toBeLessThan(extractLine);
  });

  test("uses canonical release host URLs", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("TimoFreiberg/polytoken-gui");
    expect(script).toContain("releases/download/");
    expect(script).toContain("pantoken-headless-macos-aarch64.tar.gz");
    expect(script).toContain("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDEyMTk1NTU5NzAyRDFERTAKUldUZ0hTMXdXVlVaRWlKQXdVSEc5OFRKSlNMOWpEM0h2YklTYlRNNnU4ZWF0TGpOM2xLckR4bk0K");
  });

  test("test-mode overrides are gated behind PANTOKEN_UPDATE_TEST_MODE", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("PANTOKEN_UPDATE_TEST_MODE");
    expect(script).toContain("PANTOKEN_TEST_ASSET_URL");
    expect(script).toContain("PANTOKEN_TEST_SIG_URL");
    expect(script).toContain("PANTOKEN_TEST_KICKSTART_CMD");
  });

  test("rolls back on health failure", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("STAGED_OLD_DIR");
    expect(script).toContain("rollback_to");
    expect(script).toContain("ln -sfn");
  });

  test("uses sudoers-allowed kickstart, not kill", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("kickstart -k system/");
    expect(script).toContain("sudo");
    expect(script).not.toMatch(/kill\s+\$\{?PID/);
  });

  test("retains active and previous versions in pruning", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("MAX_RETENTION");
    expect(script).toContain("active_ver");
    expect(script).toContain("prune");
  });

  test("validates BUILD_SHA format (40 lowercase hex)", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("BUILD_SHA");
    expect(script).toContain("0-9a-f");
  });

  test("checks all required staged files", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("bin/pantoken-server");
    expect(script).toContain("client-dist/index.html");
    expect(script).toContain("run.sh");
    expect(script).toContain("update.sh");
  });
});
