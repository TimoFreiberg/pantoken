import { describe, expect, test } from "bun:test";
import type { SessionDriverEvent, SessionRef } from "./session-driver.js";
import { foldAll, foldEvent, initialSessionState } from "./state.js";

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };
const base = (over: Partial<SessionDriverEvent> = {}) =>
  ({ sessionRef: ref, timestamp: "t", ...over }) as SessionDriverEvent;

// Core folding cases that duplicate the shared fold corpus
// (server-rs/pantoken-protocol/tests/fold-corpus/, run against BOTH TS and
// Rust folds via state.corpus.test.ts + fold_corpus.rs) were cut.
// Deleted cases + their corpus coverage:
// - assistant-delta accumulation/timestamp → assistant-delta-accumulation.json
// - user-message timestamp/references → user-message.json, user-message-with-references.json
// - queuedMessageStarted references → queued-message-started.json
// - queueUpdated → queue-updated.json
// - tool-call-closes-assistant; later-text-starts-new → multi-turn.json
// - tool lifecycle (running->ok, span stamps, still-running) → tool-lifecycle.json
// - runCompleted/runFailed interrupts tool → tool-interrupted.json, run-failed.json
// - dialog/permission queue + resolve → host-ui-approval.json
// - ambient status upserts/clears; widget → ambient-widgets.json
// - extensionCompatibilityIssue → extension-compat-issue.json
// - runFailed sets failed status + error notice → run-failed.json
// - snapshot updates title/status/config → session-updated-meta.json
// - idle sessionUpdated closes open assistant → assistant-turn-complete.json
//
// TS-unique cases kept below: customMessage inject, thinking/text channel
// separation, tool-failure, idle-sessionUpdated guard, interrupted:true,
// notify→notice, mid-turn notice, running snapshot leaves assistant open.
// Plus the overwrite-guard semantics block (preserve-on-omit, clear-on-null,
// clear-on-empty) — NOT in the corpus and load-bearing.

describe("foldEvent", () => {
  test("customMessage folds to an inject item and closes the open assistant", () => {
    const s = foldAll([
      base({ type: "assistantDelta", text: "final", channel: "text" }),
      base({
        type: "customMessage",
        id: "inject-1",
        customType: "extension-nudge",
        text: "<extension-nudge>do it</extension-nudge>",
        display: true,
        turnBoundary: true,
        timestamp: "t9",
      }),
    ]);
    // The streaming assistant is closed (no completedAt — closing the bubble does not
    // claim the turn ended), and the inject lands as its own item.
    expect(s.items[0]).toMatchObject({ kind: "assistant", streaming: false });
    expect(s.items[0]).not.toHaveProperty("completedAt");
    expect(s.items[1]).toMatchObject({
      kind: "inject",
      id: "inject-1",
      customType: "extension-nudge",
      text: "<extension-nudge>do it</extension-nudge>",
      display: true,
      turnBoundary: true,
      ts: "t9",
    });
  });

  test("keeps thinking and text on separate channels", () => {
    const s = foldAll([
      base({ type: "assistantDelta", text: "hmm", channel: "thinking" }),
      base({ type: "assistantDelta", text: "answer", channel: "text" }),
    ]);
    const a = s.items[0] as { kind: string; text: string; thinking: string };
    expect(a.thinking).toBe("hmm");
    expect(a.text).toBe("answer");
  });

  test("tool failure marks error", () => {
    const s = foldAll([
      base({ type: "toolStarted", callId: "c1", toolName: "bash" }),
      base({
        type: "toolFinished",
        callId: "c1",
        success: false,
        output: "boom",
      }),
    ]);
    expect(s.items[0]).toMatchObject({ status: "error" });
  });

  test("an idle sessionUpdated does not interrupt a live tool", () => {
    // An idle sessionUpdated can be a transient mid-tool snapshot (the daemon's
    // isStreaming briefly reads false during a rename/model change/auto-title).
    // Interrupting on it would kill a genuinely running tool — the turnActive
    // robustness design ORs independent in-flight signals precisely so a single
    // glitch can't hide the stop affordance. Orphaned tools from replay are
    // settled by the seed builder (history_to_seed_events), not the fold.
    const s = foldAll([
      base({ type: "toolStarted", callId: "c1", toolName: "bash" }),
      base({
        type: "sessionUpdated",
        timestamp: "settle-at",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t",
        },
      }),
    ]);
    expect(s.items[0]).toMatchObject({
      kind: "tool",
      status: "running",
    });
  });

  test("a toolFinished with interrupted:true sets status interrupted", () => {
    // The seed builder (history_to_seed_events) emits synthetic ToolFinished
    // with interrupted:true for orphaned tool_use blocks whose tool_result was
    // lost (e.g. to a context_cleared). The fold must map this to "interrupted"
    // (–), not "error" (✕), preserving the exact status the replay path expects.
    const s = foldAll([
      base({ type: "toolStarted", callId: "c1", toolName: "bash" }),
      base({
        type: "toolFinished",
        callId: "c1",
        success: false,
        interrupted: true,
        timestamp: "settle-at",
      }),
    ]);
    expect(s.items[0]).toMatchObject({
      kind: "tool",
      status: "interrupted",
      finishedAt: "settle-at",
    });
  });

  test("notify becomes a notice item", () => {
    const s = foldAll([
      base({
        type: "hostUiRequest",
        request: {
          kind: "notify",
          requestId: "n",
          message: "hi",
          level: "warning",
        },
      }),
    ]);
    expect(s.items[0]).toMatchObject({
      kind: "notice",
      level: "warning",
      text: "hi",
    });
  });

  test("a mid-turn notice closes the open assistant (no orphaned caret)", () => {
    const s = foldAll([
      base({ type: "assistantDelta", text: "first", channel: "text" }),
      base({
        type: "hostUiRequest",
        request: {
          kind: "notify",
          requestId: "n1",
          message: "Compacting context…",
          level: "info",
        },
      }),
      base({ type: "assistantDelta", text: "second", channel: "text" }),
    ]);
    // Two separate bubbles split by the notice; only the latest one may stream.
    const assistants = s.items.filter((i) => i.kind === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({ text: "first", streaming: false });
    expect(assistants[1]).toMatchObject({ text: "second", streaming: true });
  });

  test("a running sessionUpdated snapshot leaves the assistant open", () => {
    const s = foldAll([
      base({ type: "assistantDelta", text: "answer", channel: "text" }),
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "running",
          updatedAt: "t",
        },
      }),
    ]);
    expect(s.items[0]).toMatchObject({ kind: "assistant", streaming: true });
  });

  // ── Overwrite-guard semantics (NOT in the corpus, load-bearing) ───────────
  // preserve-on-omit, clear-on-null, clear-on-empty for facet/goal/flags/todos/
  // activePlan/permissionMonitor. The daemon sends snapshots that may omit or
  // null these fields; the fold must distinguish "omit" (preserve) from
  // "null"/"empty" (clear).

  test("snapshot.facet propagates to state.facet (the badge data path)", () => {
    const s = foldAll([
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t",
          facet: "plan",
        },
      }),
    ]);
    expect(s.facet).toBe("plan");
  });

  test("a snapshot without facet leaves an existing state.facet intact", () => {
    const s = initialSessionState();
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t1",
          facet: "plan",
        },
      }),
    );
    expect(s.facet).toBe("plan");
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t2",
        },
      }),
    );
    expect(s.facet).toBe("plan");
  });

  test("snapshot.permissionMonitor propagates to state.permissionMonitor (the badge data path)", () => {
    const s = foldAll([
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t",
          permissionMonitor: "bypass",
        },
      }),
    ]);
    expect(s.permissionMonitor).toBe("bypass");
  });

  test("a snapshot without permissionMonitor leaves an existing state.permissionMonitor intact", () => {
    const s = initialSessionState();
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t1",
          permissionMonitor: "autonomous",
        },
      }),
    );
    expect(s.permissionMonitor).toBe("autonomous");
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t2",
        },
      }),
    );
    expect(s.permissionMonitor).toBe("autonomous");
  });

  test("snapshot.activePlan propagates to state.activePlan (the overlay data path)", () => {
    const planText = "# Plan\n- Step 1\n- Step 2";
    const s = foldAll([
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t",
          activePlan: planText,
        },
      }),
    ]);
    expect(s.activePlan).toBe(planText);
  });

  test("a snapshot without activePlan leaves an existing state.activePlan intact", () => {
    const s = initialSessionState();
    const planText = "# My Plan\nDo the thing.";
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t1",
          activePlan: planText,
        },
      }),
    );
    expect(s.activePlan).toBe(planText);
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t2",
        },
      }),
    );
    expect(s.activePlan).toBe(planText);
  });

  test("snapshot.goal propagates to state.goal (the badge data path)", () => {
    const goal = { summary: "Ship feature X", lifecycle: "active" };
    const s = foldAll([
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t",
          goal,
        },
      }),
    ]);
    expect(s.goal).toEqual(goal);
  });

  test("a snapshot without goal leaves an existing state.goal intact", () => {
    const goal = { summary: "Ship feature X", lifecycle: "active" };
    const s = initialSessionState();
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t1",
          goal,
        },
      }),
    );
    expect(s.goal).toEqual(goal);
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t2",
        },
      }),
    );
    expect(s.goal).toEqual(goal);
  });

  test("snapshot.goal = null clears state.goal (the cleared-goal data path)", () => {
    const goal = { summary: "Ship feature X", lifecycle: "active" };
    const s = initialSessionState();
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t1",
          goal,
        },
      }),
    );
    expect(s.goal).toEqual(goal);
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t2",
          goal: null,
        },
      }),
    );
    expect(s.goal).toBeUndefined();
  });

  test("snapshot.flags propagates to state.flags (the sidebar data path)", () => {
    const flags = [
      { path: "src/app.ts", mode: "included" as const },
      { path: "README.md", mode: "referenced" as const },
    ];
    const s = foldAll([
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t",
          flags,
        },
      }),
    ]);
    expect(s.flags).toEqual(flags);
  });

  test("a snapshot without flags leaves existing state.flags intact", () => {
    const flags = [{ path: "src/app.ts", mode: "included" as const }];
    const s = initialSessionState();
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t1",
          flags,
        },
      }),
    );
    expect(s.flags).toEqual(flags);
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t2",
        },
      }),
    );
    expect(s.flags).toEqual(flags);
  });

  test("snapshot.flags = [] clears state.flags to empty", () => {
    const flags = [{ path: "src/app.ts", mode: "included" as const }];
    const s = initialSessionState();
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t1",
          flags,
        },
      }),
    );
    expect(s.flags).toEqual(flags);
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t2",
          flags: [],
        },
      }),
    );
    expect(s.flags).toEqual([]);
  });

  test("snapshot.todos propagates to state.todos (the sidebar data path)", () => {
    const todos = [
      {
        id: 1,
        title: "Write tests",
        description: "Add unit tests for the fold",
        status: "in_progress" as const,
        dependencies: [] as readonly number[],
        createdAt: "2025-07-09T10:00:00Z",
      },
    ];
    const s = foldAll([
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t",
          todos,
        },
      }),
    ]);
    expect(s.todos).toEqual(todos);
  });

  test("a snapshot without todos leaves existing state.todos intact", () => {
    const todos = [
      {
        id: 1,
        title: "Write tests",
        description: "Add unit tests",
        status: "pending" as const,
        dependencies: [] as readonly number[],
        createdAt: "2025-07-09T10:00:00Z",
      },
    ];
    const s = initialSessionState();
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t1",
          todos,
        },
      }),
    );
    expect(s.todos).toEqual(todos);
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t2",
        },
      }),
    );
    expect(s.todos).toEqual(todos);
  });
});
