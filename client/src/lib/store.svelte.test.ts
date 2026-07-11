import { afterEach, describe, expect, test } from "bun:test";
import { store } from "./store.svelte.js";

const SESSION_ID = "session-under-test";
const SESSION = {
  workspaceId: "workspace-under-test",
  sessionId: SESSION_ID,
};

describe("stop operation lifecycle", () => {
  afterEach(() => {
    store.clearError();
  });

  test("clears an unconfirmed stop and its error when the turn resumes", () => {
    // This test is intentionally focused on the recovery branch: an unconfirmed
    // session-scoped stop must be cleared when a resumed turn is folded.
    store.session.ref = SESSION;
    store.session.status = "idle";
    store.abort();
    expect(store.stopState).toBe("unconfirmed");
    expect(store.lastError).toBe("Can't stop the agent while offline — it keeps running.");

    // A resumed assistant stream makes turnActive true. Calling the same private
    // reconciliation hook used after each folded event keeps this test independent
    // of WebSocket transport and timer scheduling.
    store.session.status = "running";
    (store as unknown as { settleStopOperation: () => void }).settleStopOperation();

    expect(store.stopState).toBeNull();
    expect(store.lastError).toBeNull();
  });
});
