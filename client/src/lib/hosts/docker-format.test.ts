import { describe, expect, test } from "bun:test";
import {
  humanizeContainerName,
  humanizeSshHost,
  suggestPantokenRoot,
  formatBacking,
  rootRiskKey,
  ephemeralRiskKey,
  socketRiskKey,
  isRiskAckValid,
  computeRiskKeys,
  risksNeedingAcknowledgement,
  findSocketMount,
  formatFailureFamily,
} from "./docker-format.js";
import type { ContainerInspection } from "./types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function inspection(overrides: Partial<ContainerInspection> = {}): ContainerInspection {
  return {
    name: "work-api-dev",
    containerId: "abc123def456",
    image: "node:20-alpine",
    running: true,
    configuredUser: "dev",
    resolvedUser: "dev",
    resolvedUid: 1000,
    resolvedGid: 1000,
    resolvedHome: "/home/dev",
    os: "linux",
    arch: "arm64",
    pantokenRootSuggestion: "/home/dev/.local/share/pantoken",
    mounts: [
      {
        type: "volume",
        name: "pantoken-data",
        destination: "/home/dev/.local/share/pantoken",
        readOnly: false,
      },
    ],
    ...overrides,
  };
}

// ── Formatter table tests (humanize*, suggestPantokenRoot, formatBacking) ──
// These are simple input→output mappings; one table-driven test per function
// replaces the per-case describe blocks. The impl is 396 lines — compact, not blind-delete.

describe("formatter mappings", () => {
  test("humanizeContainerName splits on -/_/. and capitalizes", () => {
    for (const [input, expected] of [
      ["work-api-dev", "Work API Dev"],
      ["work_api", "Work API"],
      ["work.api.dev", "Work API Dev"],
      ["work-api_dev.test", "Work API Dev Test"],
      ["", ""],
      ["postgres", "Postgres"],
      ["nightly-runner", "Nightly Runner"],
    ] as const) {
      expect(humanizeContainerName(input)).toBe(expected);
    }
  });

  test("humanizeSshHost strips user@ prefix and port", () => {
    for (const [input, expected] of [
      ["dev@dev-server", "dev-server"],
      ["dev@dev-server:2222", "dev-server"],
      ["dev-server", "dev-server"],
    ] as const) {
      expect(humanizeSshHost(input)).toBe(expected);
    }
  });

  test("suggestPantokenRoot appends /.local/share/pantoken, strips trailing slashes", () => {
    for (const [input, expected] of [
      ["/home/dev", "/home/dev/.local/share/pantoken"],
      ["/home/dev/", "/home/dev/.local/share/pantoken"],
      ["/home/dev///", "/home/dev/.local/share/pantoken"],
      ["/root", "/root/.local/share/pantoken"],
    ] as const) {
      expect(suggestPantokenRoot(input)).toBe(expected);
    }
    expect(suggestPantokenRoot("~")).not.toBe("~");
  });

  test("formatBacking describes the covering mount or ephemeral layer", () => {
    expect(formatBacking(inspection())).toBe("Persistent · volume pantoken-data");
    expect(formatBacking(inspection({
      mounts: [{ type: "bind", source: "/host/data", destination: "/home/dev/.local/share/pantoken", readOnly: false }],
    }))).toBe("Persistent · bind mount /host/data");
    expect(formatBacking(inspection({ mounts: [] }))).toBe("Ephemeral · container writable layer");
    // Longest prefix match: volume covers root more specifically than the parent bind.
    expect(formatBacking(inspection({
      mounts: [
        { type: "bind", source: "/host/home", destination: "/home/dev", readOnly: false },
        { type: "volume", name: "pantoken-data", destination: "/home/dev/.local/share/pantoken", readOnly: false },
      ],
    }))).toBe("Persistent · volume pantoken-data");
  });
});

// ── formatFailureFamily ──────────────────────────────────────────────────────

describe("formatFailureFamily", () => {
  test("all families map to a non-empty label, and most to a non-empty action", () => {
    const families = [
      "dockerUnavailable", "containerNotFound", "containerStopped",
      "ambiguousMatch", "userMissing", "acknowledgementRequired",
      "rootNotWritable", "rootNotMounted", "replacementMismatch",
      "containerSupportUnavailable", "containerNotRunning",
    ] as const;

    for (const family of families) {
      const info = formatFailureFamily(family);
      expect(info.label.length).toBeGreaterThan(0);
      if (family !== "containerSupportUnavailable") {
        expect(info.action.length).toBeGreaterThan(0);
      }
    }
  });
});

// ── Socket mount detection ───────────────────────────────────────────────────

describe("findSocketMount", () => {
  test("detects bind mount with source ending in docker.sock; returns undefined otherwise", () => {
    expect(findSocketMount([
      { type: "bind" as const, source: "/var/run/docker.sock", destination: "/var/run/docker.sock", readOnly: false },
    ])).toBeDefined();
    expect(findSocketMount([
      { type: "volume" as const, name: "data", destination: "/data", readOnly: false },
    ])).toBeUndefined();
  });
});

// ── Risk invalidation (real fingerprint semantics — KEEP) ───────────────────

const baseEnv = {
  containerId: "abc123def456",
  pantokenRoot: "/home/dev/.local/share/pantoken",
  backingKey: "Persistent · volume pantoken-data",
  hasSocketMount: false,
};

describe("riskInvalidation", () => {
  test("root ack invalidated by new container ID", () => {
    const key1 = rootRiskKey({ ...baseEnv, containerId: "container-A" });
    const key2 = rootRiskKey({ ...baseEnv, containerId: "container-B" });
    expect(key1).not.toBe(key2);
    expect(isRiskAckValid("rootExecution", key1, { ...baseEnv, containerId: "container-A" })).toBe(true);
    expect(isRiskAckValid("rootExecution", key1, { ...baseEnv, containerId: "container-B" })).toBe(false);
  });

  test("ephemeral waiver invalidated by root path change", () => {
    const key1 = ephemeralRiskKey({ ...baseEnv, pantokenRoot: "/home/dev/.local/share/pantoken" });
    const key2 = ephemeralRiskKey({ ...baseEnv, pantokenRoot: "/data/pantoken" });
    expect(key1).not.toBe(key2);
  });

  test("ephemeral waiver invalidated by mount backing change", () => {
    const key1 = ephemeralRiskKey({ ...baseEnv, backingKey: "Persistent · volume pantoken-data" });
    const key2 = ephemeralRiskKey({ ...baseEnv, backingKey: "Ephemeral · container writable layer" });
    expect(key1).not.toBe(key2);
  });

  test("socket ack invalidated by container replacement", () => {
    const env1 = { ...baseEnv, hasSocketMount: true, socketMountKey: "/var/run/docker.sock" };
    const env2 = { ...baseEnv, hasSocketMount: true, socketMountKey: "/var/run/docker.sock" };
    env2.containerId = "new-container-id";
    const key1 = socketRiskKey(env1);
    const key2 = socketRiskKey(env2);
    expect(key1).not.toBe(key2);
  });

  test("socket ack invalidated by socket mount change", () => {
    const env1 = { ...baseEnv, hasSocketMount: true, socketMountKey: "/var/run/docker.sock" };
    const env2 = { ...baseEnv, hasSocketMount: true, socketMountKey: "/host/docker.sock" };
    expect(socketRiskKey(env1)).not.toBe(socketRiskKey(env2));
  });

  test("socket none when no socket mount", () => {
    expect(socketRiskKey({ ...baseEnv, hasSocketMount: false })).toBe("socket:none");
  });

  test("computeRiskKeys returns all three keys", () => {
    const keys = computeRiskKeys(baseEnv);
    expect(keys.root).toContain("root:");
    expect(keys.ephemeral).toContain("ephemeral:");
    expect(keys.socket).toBe("socket:none");
  });

  test("risksNeedingAcknowledgement with no acks returns all", () => {
    const needed = risksNeedingAcknowledgement({}, baseEnv);
    expect(needed).toContain("rootExecution");
    expect(needed).toContain("ephemeralData");
    expect(needed).not.toContain("dockerSocket"); // no socket mount
  });

  test("risksNeedingAcknowledgement with valid acks returns empty", () => {
    const keys = computeRiskKeys(baseEnv);
    const needed = risksNeedingAcknowledgement(
      { rootFingerprint: keys.root, ephemeralFingerprint: keys.ephemeral },
      baseEnv,
    );
    expect(needed).toEqual([]);
  });

  test("risksNeedingAcknowledgement with socket mount + no socket ack returns socket", () => {
    const env = { ...baseEnv, hasSocketMount: true, socketMountKey: "/var/run/docker.sock" };
    const keys = computeRiskKeys(env);
    const needed = risksNeedingAcknowledgement(
      { rootFingerprint: keys.root, ephemeralFingerprint: keys.ephemeral },
      env,
    );
    expect(needed).toContain("dockerSocket");
  });

  test("risksNeedingAcknowledgement with valid socket ack returns empty", () => {
    const env = { ...baseEnv, hasSocketMount: true, socketMountKey: "/var/run/docker.sock" };
    const keys = computeRiskKeys(env);
    const needed = risksNeedingAcknowledgement(
      { rootFingerprint: keys.root, ephemeralFingerprint: keys.ephemeral, dockerSocketFingerprint: keys.socket },
      env,
    );
    expect(needed).toEqual([]);
  });
});
