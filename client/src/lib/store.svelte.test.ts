import { afterEach, describe, expect, test, vi } from "vitest";
import { PROTOCOL_VERSION, type ServerMessage } from "@pantoken/protocol";
import { buildFullHash } from "./build-info.js";
import { namespacedKey } from "./hosts/persistence.js";
import { store } from "./store.svelte.js";
import {
  settleStaleBuild,
  settleStopOperation,
  type StopOperation,
} from "./store-helpers.js";

const SESSION_ID = "session-under-test";
const ERROR = "Can't stop the agent while offline — it keeps running.";

function unconfirmed(): StopOperation {
  return {
    requestId: "request-under-test",
    sessionId: SESSION_ID,
    state: "unconfirmed",
    activityVersion: 7,
    error: ERROR,
  };
}

describe("stop operation lifecycle", () => {
  test("leaves a stop unchanged for another session or no operation", () => {
    const operation = unconfirmed();
    const mismatched = settleStopOperation(
      operation,
      "another-session",
      false,
      7,
      ERROR,
    );
    const empty = settleStopOperation(null, SESSION_ID, false, 7, ERROR);

    expect(mismatched.operation).toBe(operation);
    expect(mismatched.clearError).toBe(false);
    expect(mismatched.lateConfirmation).toBe(false);
    expect(empty.operation).toBeNull();
    expect(empty.clearError).toBe(false);
    expect(empty.lateConfirmation).toBe(false);
  });

  test("keeps an unconfirmed stop through passive active snapshots", () => {
    const operation = unconfirmed();
    const result = settleStopOperation(operation, SESSION_ID, true, 7, ERROR);

    expect(result.operation).toBe(operation);
    expect(result.clearError).toBe(false);
    expect(result.lateConfirmation).toBe(false);
  });

  test("clears an unconfirmed stop when meaningful activity continues", () => {
    const result = settleStopOperation(
      unconfirmed(),
      SESSION_ID,
      true,
      8,
      ERROR,
    );

    expect(result.operation).toBeNull();
    expect(result.clearError).toBe(true);
    expect(result.lateConfirmation).toBe(false);
  });

  test("preserves a newer error when an unconfirmed stop clears on continued activity", () => {
    const result = settleStopOperation(
      unconfirmed(),
      SESSION_ID,
      true,
      8,
      "A newer error",
    );

    expect(result.operation).toBeNull();
    expect(result.clearError).toBe(false);
    expect(result.lateConfirmation).toBe(false);
  });

  test("keeps a still-confirming stop while the agent remains active", () => {
    const operation: StopOperation = {
      ...unconfirmed(),
      state: "stopping",
      error: undefined,
    };
    const result = settleStopOperation(operation, SESSION_ID, true, 7, null);

    expect(result.operation).toBe(operation);
    expect(result.clearError).toBe(false);
    expect(result.lateConfirmation).toBe(false);
  });

  test("clears a stopping operation after an inactive turn without late confirmation", () => {
    const operation: StopOperation = {
      ...unconfirmed(),
      state: "stopping",
    };
    const matchingError = settleStopOperation(
      operation,
      SESSION_ID,
      false,
      7,
      ERROR,
    );
    const newerError = settleStopOperation(
      operation,
      SESSION_ID,
      false,
      7,
      "A newer error",
    );

    expect(matchingError.operation).toBeNull();
    expect(matchingError.clearError).toBe(false);
    expect(matchingError.lateConfirmation).toBe(false);
    expect(newerError.operation).toBeNull();
    expect(newerError.clearError).toBe(false);
    expect(newerError.lateConfirmation).toBe(false);
  });

  test("reports a late confirmation when an unconfirmed stop finds an inactive turn", () => {
    const result = settleStopOperation(
      unconfirmed(),
      SESSION_ID,
      false,
      7,
      ERROR,
    );

    expect(result.operation).toBeNull();
    expect(result.clearError).toBe(true);
    expect(result.lateConfirmation).toBe(true);
  });
});

describe("stale build notification lifecycle", () => {
  test("served == bundle without a record: no raise, nothing to clear", () => {
    const decision = settleStaleBuild("test-full-hash", "test-full-hash", null);
    expect(decision.raise).toBe(false);
    expect(decision.notifySha).toBeNull();
    expect(decision.clear).toBe(false);
  });

  test("served == bundle with a record: clears the record", () => {
    const decision = settleStaleBuild(
      "test-full-hash",
      "test-full-hash",
      "old-sha",
    );
    expect(decision.raise).toBe(false);
    expect(decision.notifySha).toBeNull();
    expect(decision.clear).toBe(true);
  });

  test("served != bundle without a record: raises with the served sha", () => {
    const decision = settleStaleBuild("new-sha", "test-full-hash", null);
    expect(decision.raise).toBe(true);
    expect(decision.notifySha).toBe("new-sha");
    expect(decision.clear).toBe(false);
  });

  test("served != bundle with a record for the same sha: no re-raise", () => {
    // The reload/dismiss case.
    const decision = settleStaleBuild("new-sha", "test-full-hash", "new-sha");
    expect(decision.raise).toBe(false);
    expect(decision.notifySha).toBeNull();
    expect(decision.clear).toBe(false);
  });

  test("served != bundle with a record for an older sha: raises with the new sha", () => {
    const decision = settleStaleBuild("newer-sha", "test-full-hash", "old-sha");
    expect(decision.raise).toBe(true);
    expect(decision.notifySha).toBe("newer-sha");
    expect(decision.clear).toBe(false);
  });
});

describe("stale build notification wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    store.switchHost();
    localStorage.clear();
  });

  /** A hello, optionally carrying the served-bundle sha (wire field is optional). */
  function helloMsg(serverId: string, buildSha?: string): ServerMessage {
    return {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      serverId,
      serverLabel: "Test Server",
      dataDir: "/tmp",
      ...(buildSha !== undefined ? { buildSha } : {}),
    };
  }

  test("PROD gate: vi.stubEnv('PROD', true) flips import.meta.env.PROD", () => {
    vi.stubEnv("PROD", true);
    expect(import.meta.env.PROD).toBe(true);
  });

  test("a mismatched hello does not raise outside PROD builds", () => {
    store.onServer(helloMsg("server-a", "new-sha"));
    expect(store.swUpdateReady).toBe(false);
    expect(
      localStorage.getItem(namespacedKey("staleBuildNotified", "server-a")),
    ).toBeNull();
  });

  test("raises the toast and persists the served sha per serverId under PROD", () => {
    vi.stubEnv("PROD", true);
    store.onServer(helloMsg("server-a", "new-sha"));
    expect(store.swUpdateReady).toBe(true);
    expect(
      localStorage.getItem(namespacedKey("staleBuildNotified", "server-a")),
    ).toBe("new-sha");
  });

  test("a reconnect hello for the same served sha does not re-raise", () => {
    vi.stubEnv("PROD", true);
    store.onServer(helloMsg("server-a", "new-sha"));
    expect(store.swUpdateReady).toBe(true);
    store.dismissUpdate();
    store.onServer(helloMsg("server-a", "new-sha"));
    expect(store.swUpdateReady).toBe(false);
  });

  test("after a reload (host switch), the same served sha does not re-raise", () => {
    vi.stubEnv("PROD", true);
    store.onServer(helloMsg("server-a", "new-sha"));
    expect(store.swUpdateReady).toBe(true);
    store.switchHost(); // page reload: in-memory mirror gone, record survives
    store.onServer(helloMsg("server-a", "new-sha"));
    expect(store.swUpdateReady).toBe(false);
  });

  test("a bundle-matching hello clears the record, and a new sha raises again", () => {
    vi.stubEnv("PROD", true);
    const key = namespacedKey("staleBuildNotified", "server-a");
    store.onServer(helloMsg("server-a", "new-sha"));
    expect(store.swUpdateReady).toBe(true);
    store.dismissUpdate();
    // The server serves the bundle this tab is running: record cleared.
    store.onServer(helloMsg("server-a", buildFullHash));
    expect(store.swUpdateReady).toBe(false);
    expect(localStorage.getItem(key) ?? "").toBe("");
    // A later deploy of a newer sha raises again.
    store.onServer(helloMsg("server-a", "newer-sha"));
    expect(store.swUpdateReady).toBe(true);
    expect(localStorage.getItem(key)).toBe("newer-sha");
  });

  test("notified records are scoped per serverId", () => {
    vi.stubEnv("PROD", true);
    store.onServer(helloMsg("server-a", "sha-a"));
    expect(store.swUpdateReady).toBe(true);
    store.switchHost();
    store.onServer(helloMsg("server-b", "sha-b"));
    expect(store.swUpdateReady).toBe(true);
    expect(
      localStorage.getItem(namespacedKey("staleBuildNotified", "server-a")),
    ).toBe("sha-a");
    expect(
      localStorage.getItem(namespacedKey("staleBuildNotified", "server-b")),
    ).toBe("sha-b");
    // Switching back to server-a: its own record suppresses a re-raise.
    store.switchHost();
    store.onServer(helloMsg("server-a", "sha-a"));
    expect(store.swUpdateReady).toBe(false);
  });
});
