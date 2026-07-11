import { describe, expect, test } from "bun:test";
import { settleStopOperation, type StopOperation } from "./store-helpers.js";

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
