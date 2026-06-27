// projectTree flattens pi's SessionManager tree into the wire TreeSnapshot. It's pure
// (takes a structural slice) and was untested — the mock driver returns a canned
// TreeSnapshot, so the real describe() mapping (the switch over entry.type + msg.role →
// kind/preview) had no coverage. A regression in kind assignment or preview text would
// silently mis-render the client's branch tree / break filters. These tests pin the
// kind/preview mapping per entry variant, depth-first flattening, parent linking, the
// leafId pass-through, and the label passthrough.

import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { projectTree } from "./tree-map.js";

// Structural slice matching projectTree's param: a read-only getTree() + getLeafId().
// Building PiTreeNode-shaped fakes directly keeps the test DOM-free and pins the
// projection, not pi's real SessionManager.
interface FakeNode {
  entry: SessionEntry;
  children?: FakeNode[];
  label?: string;
}

// Map the test's FakeNode tree to the PiTreeNode shape projectTree walks: children
// default to [] and the mapping recurses so every level has the same shape. Named
// (not ReturnType<typeof toPi>) so the recursive `children` type resolves cleanly —
// a self-referential ReturnType confuses TS's inference and breaks sm()'s signature.
interface PiNode {
  entry: SessionEntry;
  children: PiNode[];
  label?: string;
}

function toPi(n: FakeNode): PiNode {
  return {
    entry: n.entry,
    children: (n.children ?? []).map(toPi),
    label: n.label,
  };
}

function sm(tree: FakeNode[], leafId: string | null) {
  return {
    getTree: () => tree.map(toPi),
    getLeafId: () => leafId,
  };
}

const msg = (
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  ts = "2026-06-26T00:00:00Z",
): SessionEntry =>
  ({
    type: "message",
    id,
    parentId,
    timestamp: ts,
    message: { role, content },
  }) as SessionEntry;

describe("projectTree", () => {
  test("empty tree → empty nodes, leafId passed through", () => {
    expect(projectTree(sm([], null))).toEqual({ nodes: [], leafId: null });
    expect(projectTree(sm([], "leaf-1"))).toEqual({
      nodes: [],
      leafId: "leaf-1",
    });
  });

  test("flattens depth-first, preserving parent links", () => {
    const tree: FakeNode[] = [
      {
        entry: msg("a", null, "user", "root"),
        children: [
          { entry: msg("b", "a", "assistant", "reply") },
          {
            entry: msg("c", "b", "user", "follow up"),
            children: [{ entry: msg("d", "c", "assistant", "reply2") }],
          },
        ],
      },
    ];
    const { nodes } = projectTree(sm(tree, "d"));
    expect(nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    expect(nodes.map((n) => n.parentId)).toEqual([null, "a", "b", "c"]);
  });

  test("maps message roles to kind + previews text content", () => {
    const tree: FakeNode[] = [
      { entry: msg("u", null, "user", "hello world") },
      {
        entry: msg("a", null, "assistant", [
          { type: "text", text: "hi there" },
        ]),
      },
      {
        entry: {
          ...msg("t", null, "toolResult", ""),
          message: { role: "toolResult", toolName: "bash" },
        } as SessionEntry,
      },
      {
        entry: {
          ...msg("b", null, "bashExecution", ""),
          message: { role: "bashExecution", command: "ls -la" },
        } as SessionEntry,
      },
    ];
    const { nodes } = projectTree(sm(tree, null));
    expect(nodes.map((n) => n.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "bash",
    ]);
    expect(nodes.map((n) => n.preview)).toEqual([
      "hello world",
      "hi there",
      "[bash]",
      "[bash] ls -la",
    ]);
  });

  test("whitespace in content is normalised + preview is capped", () => {
    const messy = "  foo\n\n  bar   baz  ";
    const { nodes } = projectTree(
      sm([{ entry: msg("u", null, "user", messy) }], null),
    );
    expect(nodes[0]?.preview).toBe("foo bar baz");
  });

  test("non-message entry types map to their kinds", () => {
    const tree: FakeNode[] = [
      {
        entry: {
          type: "branch_summary",
          id: "s",
          parentId: null,
          timestamp: "t",
          summary: "summary text",
        } as SessionEntry,
      },
      {
        entry: {
          type: "compaction",
          id: "c",
          parentId: null,
          timestamp: "t",
          tokensBefore: 12_000,
        } as SessionEntry,
      },
      {
        entry: {
          type: "model_change",
          id: "m",
          parentId: null,
          timestamp: "t",
          provider: "anthropic",
          modelId: "claude-3-5-haiku",
        } as SessionEntry,
      },
      {
        entry: {
          type: "thinking_level_change",
          id: "tl",
          parentId: null,
          timestamp: "t",
          thinkingLevel: "high",
        } as SessionEntry,
      },
    ];
    const { nodes } = projectTree(sm(tree, null));
    expect(nodes.map((n) => n.kind)).toEqual([
      "branch-summary",
      "compaction",
      "model-change",
      "thinking-change",
    ]);
    expect(nodes.map((n) => n.preview)).toEqual([
      "summary text",
      "[compaction: 12k tokens]",
      "[model: claude-3-5-haiku]",
      "[thinking: high]",
    ]);
  });

  test("label and ts are passed through to the node", () => {
    const { nodes } = projectTree(
      sm(
        [
          {
            entry: msg("u", null, "user", "hi", "2026-01-01T00:00:00Z"),
            label: "my-label",
          },
        ],
        "u",
      ),
    );
    expect(nodes[0]).toEqual({
      id: "u",
      parentId: null,
      kind: "user",
      preview: "hi",
      ts: "2026-01-01T00:00:00Z",
      label: "my-label",
    });
  });
});
