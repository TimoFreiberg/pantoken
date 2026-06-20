import { describe, expect, test } from "bun:test";
import type { TreeNodeInfo } from "@pilot/protocol";
import { buildTreeRows, gutterKind, type TreeRow } from "./tree-view.js";

// A small auth-refactor tree mirroring the fixture: a linear root chain that forks at the
// plan step into the active "sessions" branch and an abandoned branch (a summary).
//
//   u1 ─ a1 ─ t1 ─ a2 ┬ u2 ─ a3   (active leaf)
//                     └ bs1        (abandoned)
function authTree(): TreeNodeInfo[] {
  return [
    {
      id: "u1",
      parentId: null,
      kind: "user",
      preview: "refactor auth",
      ts: "1",
    },
    {
      id: "a1",
      parentId: "u1",
      kind: "assistant",
      preview: "reading files",
      ts: "2",
    },
    { id: "t1", parentId: "a1", kind: "tool", preview: "[read]", ts: "3" },
    {
      id: "a2",
      parentId: "t1",
      kind: "assistant",
      preview: "here's a plan",
      ts: "4",
    },
    {
      id: "u2",
      parentId: "a2",
      kind: "user",
      preview: "use sessions",
      ts: "5",
      label: "sessions",
    },
    { id: "a3", parentId: "u2", kind: "assistant", preview: "done", ts: "6" },
    {
      id: "bs1",
      parentId: "a2",
      kind: "branch-summary",
      preview: "JWT, abandoned",
      ts: "7",
    },
  ];
}

const ids = (rows: TreeRow[]) => rows.map((r) => r.node.id);
const row = (rows: TreeRow[], id: string) =>
  rows.find((r) => r.node.id === id)!;

describe("buildTreeRows", () => {
  test("single-child chains stay flat (depth 0, no connectors)", () => {
    const rows = buildTreeRows(authTree(), "a3", "all", "");
    // The root chain u1->a1->t1->a2 is all single-child: every row at depth 0, no connector.
    for (const id of ["u1", "a1", "t1", "a2"]) {
      expect(row(rows, id).depth).toBe(0);
      expect(row(rows, id).connectorCol).toBe(-1);
    }
  });

  test("a branch point indents its children with ├ / └ connectors", () => {
    const rows = buildTreeRows(authTree(), "a3", "all", "");
    // a2 forks into u2 (active) + bs1 (abandoned): both depth 1, connector at col 0.
    expect(row(rows, "u2").depth).toBe(1);
    expect(row(rows, "u2").connectorCol).toBe(0);
    expect(row(rows, "u2").isLast).toBe(false); // ├ (active branch sorts first)
    expect(row(rows, "bs1").depth).toBe(1);
    expect(row(rows, "bs1").isLast).toBe(true); // └ (last sibling)
    expect(gutterKind(row(rows, "u2"), 0)).toBe("tee");
    expect(gutterKind(row(rows, "bs1"), 0)).toBe("corner");
  });

  test("a continuation under a non-last branch child carries the rail (no gap)", () => {
    const rows = buildTreeRows(authTree(), "a3", "all", "");
    // a3 continues u2 (the non-last sibling), so its col-0 gutter must draw a vertical rail
    // — this is what makes the connector line continuous down to bs1's corner.
    expect(row(rows, "a3").depth).toBe(1);
    expect(row(rows, "a3").connectorCol).toBe(-1);
    expect(gutterKind(row(rows, "a3"), 0)).toBe("rail");
  });

  test("active path is marked and the active branch sorts first", () => {
    const rows = buildTreeRows(authTree(), "a3", "all", "");
    for (const id of ["u1", "a1", "t1", "a2", "u2", "a3"])
      expect(row(rows, id).onActivePath).toBe(true);
    expect(row(rows, "bs1").onActivePath).toBe(false);
    expect(row(rows, "a3").isLeaf).toBe(true);
    // u2 (active) appears before bs1 (abandoned) despite a later... no, earlier ts — but
    // active-first ordering is what guarantees it regardless of ts.
    expect(ids(rows).indexOf("u2")).toBeLessThan(ids(rows).indexOf("bs1"));
  });

  test("default (skeleton) filter hides tools but keeps the fork visible", () => {
    const rows = buildTreeRows(authTree(), "a3", "default", "");
    expect(ids(rows)).not.toContain("t1"); // tool hidden
    // a2 re-parents onto a1 (nearest visible ancestor) and stays a branch point.
    expect(row(rows, "a2").depth).toBe(0);
    expect(row(rows, "u2").depth).toBe(1);
    expect(row(rows, "u2").connectorCol).toBe(0);
    expect(ids(rows)).toContain("bs1"); // branch summary kept
  });

  test("user-only and labeled-only filters", () => {
    expect(ids(buildTreeRows(authTree(), "a3", "user-only", ""))).toEqual([
      "u1",
      "u2",
    ]);
    // Only u2 carries a label.
    expect(ids(buildTreeRows(authTree(), "a3", "labeled-only", ""))).toEqual([
      "u2",
    ]);
  });

  test("search filters by preview/label text", () => {
    const rows = buildTreeRows(authTree(), "a3", "all", "sessions");
    // u2 matches by both preview ('use sessions') and label ('sessions').
    expect(ids(rows)).toContain("u2");
    expect(ids(rows)).not.toContain("bs1");
  });

  test("empty tree yields no rows", () => {
    expect(buildTreeRows([], null, "default", "")).toEqual([]);
  });
});
