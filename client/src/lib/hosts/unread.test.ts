import { describe, expect, test } from "bun:test";
import type { SessionAttention } from "@pantoken/protocol";
import {
  applySessionStatus,
  clearOnSelect,
  initialUnreadState,
} from "./unread.js";

function attention(
  sessionId: string,
  phase: SessionAttention["phase"],
): SessionAttention {
  return {
    sessionId,
    phase,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("applySessionStatus", () => {
  test("initial background status establishes a read baseline (first sessionStatus never sets unseen)", () => {
    const state = applySessionStatus(
      initialUnreadState(),
      {
        runningIds: ["s1", "s2"],
        attention: [attention("s1", "running")],
      },
      false, // inactive
    );
    expect(state.baselined).toBe(true);
    expect(state.unseen).toBe(false);
    expect(state.running).toBe(true);
  });

  test("inactive running → done sets computer unseen", () => {
    // First status: s1 is running, baseline established.
    let state = applySessionStatus(
      initialUnreadState(),
      { runningIds: ["s1"] },
      false,
    );
    expect(state.unseen).toBe(false);

    // Second status: s1 is no longer running (it completed).
    state = applySessionStatus(
      state,
      { runningIds: [] }, // s1 left runningIds
      false, // still inactive
    );
    expect(state.unseen).toBe(true);
    expect(state.running).toBe(false);
  });

  test("selecting a computer clears ordinary unseen", () => {
    // Drive an inactive host to unseen.
    let state = applySessionStatus(
      initialUnreadState(),
      { runningIds: ["s1"] },
      false,
    );
    state = applySessionStatus(state, { runningIds: [] }, false);
    expect(state.unseen).toBe(true);

    // Select the host.
    state = clearOnSelect(state);
    expect(state.unseen).toBe(false);
  });

  test("waiting/failed attention survives selection", () => {
    let state = applySessionStatus(
      initialUnreadState(),
      { runningIds: ["s1"], attention: [attention("s1", "waiting")] },
      false,
    );
    expect(state.waiting).toBe(true);

    // Select the host.
    state = clearOnSelect(state);
    expect(state.unseen).toBe(false);
    expect(state.waiting).toBe(true);

    // Same for failed.
    state = applySessionStatus(
      initialUnreadState(),
      { runningIds: ["s1"], attention: [attention("s1", "failed")] },
      false,
    );
    expect(state.failed).toBe(true);
    state = clearOnSelect(state);
    expect(state.failed).toBe(true);
  });

  test("running derives from non-empty runningIds", () => {
    const state = applySessionStatus(
      initialUnreadState(),
      { runningIds: ["s1"] },
      false,
    );
    expect(state.running).toBe(true);
  });

  test("running derives from non-empty initializingIds", () => {
    const state = applySessionStatus(
      initialUnreadState(),
      { runningIds: [], initializingIds: ["s1"] },
      false,
    );
    expect(state.running).toBe(true);
  });

  test("running is false when both runningIds and initializingIds are empty", () => {
    const state = applySessionStatus(
      initialUnreadState(),
      { runningIds: [], initializingIds: [] },
      false,
    );
    expect(state.running).toBe(false);
  });

  test("a new waiting attention item on an inactive host sets unseen", () => {
    // Baseline: no attention, nothing running.
    let state = applySessionStatus(
      initialUnreadState(),
      { runningIds: [] },
      false,
    );
    expect(state.waiting).toBe(false);
    expect(state.unseen).toBe(false);

    // A new waiting attention appears.
    state = applySessionStatus(
      state,
      { runningIds: [], attention: [attention("s1", "waiting")] },
      false, // inactive
    );
    expect(state.waiting).toBe(true);
    expect(state.unseen).toBe(true);
  });

  test("active host does not set unseen on running→done transition", () => {
    let state = applySessionStatus(
      initialUnreadState(),
      { runningIds: ["s1"] },
      true, // active
    );
    expect(state.unseen).toBe(false);

    // s1 completes.
    state = applySessionStatus(
      state,
      { runningIds: [] },
      true, // still active
    );
    expect(state.unseen).toBe(false);
  });

  test("active host does not set unseen on new waiting attention", () => {
    let state = applySessionStatus(
      initialUnreadState(),
      { runningIds: [] },
      true, // active
    );

    state = applySessionStatus(
      state,
      { runningIds: [], attention: [attention("s1", "waiting")] },
      true, // active
    );
    expect(state.unseen).toBe(false);
    expect(state.waiting).toBe(true);
  });

  test("prevRunningIds tracks the previous sessionStatus running set", () => {
    const state = applySessionStatus(
      initialUnreadState(),
      { runningIds: ["s1", "s2"] },
      false,
    );
    expect(state.prevRunningIds.has("s1")).toBe(true);
    expect(state.prevRunningIds.has("s2")).toBe(true);
    expect(state.prevRunningIds.has("s3")).toBe(false);
  });
});
