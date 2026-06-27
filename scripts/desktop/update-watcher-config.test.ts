// configFromEnv parses the watcher's config from process.env + argv. Untested —
// the regression-prone parts are the empty-string→undefined handling (PILOT_TOKEN=""
// must NOT be treated as a real empty token, mirroring the auth gate's null-vs-empty
// distinction), the dryRun dual-source (env =1 OR --dry-run argv), nativeNotify's
// opt-out (defaults ON, only "0" turns it off), and the URL composition from
// PILOT_PORT / PILOT_SERVER_URL. Reads process.env + process.argv at call time →
// mutate-and-restore per test (same seam as config.ts's tokenOk).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { configFromEnv } from "./update-watcher.js";

const ENV_KEYS = [
  "PILOT_PORT",
  "PILOT_SERVER_URL",
  "PILOT_APP_CLONE",
  "PILOT_UPDATE_REMOTE",
  "PILOT_UPDATE_BRANCH",
  "PILOT_HEALTH_URL",
  "PILOT_UPDATE_URL",
  "PILOT_TOKEN",
  "PILOT_APP_DESKTOP_SHA",
  "PILOT_DATA_DIR",
  "PILOT_UPDATE_INTERVAL_MS",
  "PILOT_UPDATE_POLL_MS",
  "PILOT_UPDATE_DRY_RUN",
  "PILOT_UPDATE_NATIVE_NOTIFY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("configFromEnv", () => {
  test("defaults: localhost:8787, origin/main, 60s/5s, dryRun off, nativeNotify on", () => {
    const c = configFromEnv([]);
    expect(c.remote).toBe("origin");
    expect(c.branch).toBe("main");
    expect(c.healthUrl).toBe("http://127.0.0.1:8787/health");
    expect(c.updateUrl).toBe("http://127.0.0.1:8787/update/state");
    expect(c.intervalMs).toBe(60_000);
    expect(c.pollMs).toBe(5_000);
    expect(c.dryRun).toBe(false);
    expect(c.nativeNotify).toBe(true);
  });

  test("PILOT_PORT composes the base URL for health + update", () => {
    process.env.PILOT_PORT = "9000";
    const c = configFromEnv([]);
    expect(c.healthUrl).toBe("http://127.0.0.1:9000/health");
    expect(c.updateUrl).toBe("http://127.0.0.1:9000/update/state");
  });

  test("PILOT_SERVER_URL overrides the port-derived base entirely", () => {
    process.env.PILOT_PORT = "9000"; // ignored when SERVER_URL is set
    process.env.PILOT_SERVER_URL = "https://pilot.tailnet.example";
    const c = configFromEnv([]);
    expect(c.healthUrl).toBe("https://pilot.tailnet.example/health");
    expect(c.updateUrl).toBe("https://pilot.tailnet.example/update/state");
  });

  test("PILOT_TOKEN: a set token is passed through; an EMPTY string becomes undefined", () => {
    // The empty-vs-set distinction matters downstream (Bearer header construction):
    // an empty env var must not become a literal "" token sent as "Bearer ".
    process.env.PILOT_TOKEN = "secret";
    expect(configFromEnv([]).token).toBe("secret");
    process.env.PILOT_TOKEN = "";
    expect(configFromEnv([]).token).toBeUndefined();
  });

  test("PILOT_APP_DESKTOP_SHA: empty → undefined (never relaunch on an unknown sha)", () => {
    // The native-relaunch path keys off appDesktopSha; an empty/unknown sha must be
    // undefined (not "") so the watcher never triggers a relaunch it can't reason about.
    process.env.PILOT_APP_DESKTOP_SHA = "abc123";
    expect(configFromEnv([]).appDesktopSha).toBe("abc123");
    process.env.PILOT_APP_DESKTOP_SHA = "";
    expect(configFromEnv([]).appDesktopSha).toBeUndefined();
  });

  test("dryRun is true via PILOT_UPDATE_DRY_RUN=1 OR --dry-run argv (either source)", () => {
    process.env.PILOT_UPDATE_DRY_RUN = "1";
    expect(configFromEnv([]).dryRun).toBe(true);
    delete process.env.PILOT_UPDATE_DRY_RUN;
    expect(configFromEnv(["node", "script.ts", "--dry-run"]).dryRun).toBe(true);
    // neither set → off
    expect(configFromEnv([]).dryRun).toBe(false);
    // =0 or any other value is NOT a dry-run trigger
    process.env.PILOT_UPDATE_DRY_RUN = "0";
    expect(configFromEnv([]).dryRun).toBe(false);
  });

  test("nativeNotify defaults ON and only '0' opts out (any other value stays on)", () => {
    // Opt-out by design: the Swift shell sets =0 once it owns notifications; everything
    // else (including unset / typos) keeps the watcher's own osascript notify on.
    expect(configFromEnv([]).nativeNotify).toBe(true);
    process.env.PILOT_UPDATE_NATIVE_NOTIFY = "0";
    expect(configFromEnv([]).nativeNotify).toBe(false);
    process.env.PILOT_UPDATE_NATIVE_NOTIFY = "false"; // not the literal "0"
    expect(configFromEnv([]).nativeNotify).toBe(true);
  });

  test("intervalMs / pollMs are Number-coerced from their env strings", () => {
    process.env.PILOT_UPDATE_INTERVAL_MS = "120000";
    process.env.PILOT_UPDATE_POLL_MS = "10000";
    const c = configFromEnv([]);
    expect(c.intervalMs).toBe(120_000);
    expect(c.pollMs).toBe(10_000);
  });

  test("explicit PILOT_DATA_DIR wins over the XDG-derived default", () => {
    process.env.PILOT_DATA_DIR = "/custom/state/pilot";
    expect(configFromEnv([]).dataDir).toBe("/custom/state/pilot");
  });

  test("absent PILOT_DATA_DIR falls back to the XDG state dir (inlined default)", () => {
    const stateHome =
      process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
    expect(configFromEnv([]).dataDir).toBe(join(stateHome, "pilot"));
  });
});
