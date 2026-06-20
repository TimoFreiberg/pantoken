// Flatten a session's branch tree (the wire's flat TreeNodeInfo[] + leafId) into a list of
// rows the TreeView renders, mirroring pi's /tree layout but tuned for a web list:
//
//   - single-child chains stay FLAT (same indent, no connector) — only true branch points
//     indent their children one level (pi's core rule);
//   - the active root->leaf path is marked, and its branch sorts first among siblings;
//   - filtering hides entries by mode/search; hidden intermediate nodes are bypassed so a
//     child re-attaches to its nearest visible ancestor (the fork stays visible even when
//     the exact fork node is filtered out), matching pi's recalculateVisualStructure.
//
// Each row carries enough connector metadata for a CSS render with CONTINUOUS rails (no
// per-character gutter gaps like the terminal): a rail is drawn for every ancestor branch
// that still has rows below this one, and the row's own ├/└ connector sits at connectorCol.

import type { TreeNodeInfo, TreeNodeKind } from "@pilot/protocol";

/** Tree view filter modes. `default` is the "skeleton": prompts + answers + branch points
 *  (tools, bash, and bookkeeping entries hidden). The others mirror pi's tree filters. */
export type TreeFilterMode = "default" | "all" | "user-only" | "labeled-only";

export const TREE_FILTER_MODES: readonly {
  mode: TreeFilterMode;
  label: string;
  title: string;
}[] = [
  { mode: "default", label: "Default", title: "Prompts, answers & branches" },
  {
    mode: "all",
    label: "All",
    title: "Every entry, including tools & bookkeeping",
  },
  { mode: "user-only", label: "Prompts", title: "Your prompts only" },
  { mode: "labeled-only", label: "Labeled", title: "Labeled nodes only" },
];

export interface TreeRow {
  readonly node: TreeNodeInfo;
  /** Branch depth (count of ancestor branch points) — the indent level. */
  readonly depth: number;
  /** Per gutter column [0, depth): draw a vertical rail (true) or blank (false). The
   *  connector column is rendered as ├/└ instead and ignores this. */
  readonly rails: readonly boolean[];
  /** Column where this row draws a ├/└ connector, or -1 for none (roots + single-child
   *  continuations). When set it's always depth-1. */
  readonly connectorCol: number;
  /** └ (last sibling) vs ├ — only meaningful when connectorCol >= 0. */
  readonly isLast: boolean;
  /** On the active root->leaf path. */
  readonly onActivePath: boolean;
  /** The current leaf (where the next message would append). */
  readonly isLeaf: boolean;
}

const BOOKKEEPING: readonly TreeNodeKind[] = [
  "tool",
  "bash",
  "compaction",
  "model-change",
  "thinking-change",
  "label",
  "session-info",
  "custom",
];

/** Whether a node passes the mode filter (search + leaf-forcing applied separately). */
function passesFilter(node: TreeNodeInfo, mode: TreeFilterMode): boolean {
  switch (mode) {
    case "all":
      return true;
    case "user-only":
      return node.kind === "user";
    case "labeled-only":
      return node.label != null;
    default:
      // Skeleton: prompts, answers (with text), and branch summaries — so abandoned
      // branches stay visible. Hide tool-only assistant turns and everything bookkeeping.
      if (node.kind === "user" || node.kind === "branch-summary") return true;
      if (node.kind === "assistant") return node.preview.trim().length > 0;
      return !BOOKKEEPING.includes(node.kind);
  }
}

/** Flatten the tree into rows under the current filter + search query. */
export function buildTreeRows(
  nodes: readonly TreeNodeInfo[],
  leafId: string | null,
  mode: TreeFilterMode,
  query: string,
): TreeRow[] {
  if (nodes.length === 0) return [];
  const byId = new Map(nodes.map((n) => [n.id, n] as const));

  // Active path: walk leaf -> root via the REAL parentId (not the filtered tree).
  const activePath = new Set<string>();
  for (let id: string | null = leafId; id != null; ) {
    if (activePath.has(id)) break; // defensive against a malformed cycle
    activePath.add(id);
    id = byId.get(id)?.parentId ?? null;
  }

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matchesSearch = (n: TreeNodeInfo): boolean =>
    tokens.length === 0 ||
    tokens.every((t) =>
      `${n.preview} ${n.label ?? ""} ${n.kind}`.toLowerCase().includes(t),
    );

  // Visible = passes mode and matches search. In the skeleton (default) view we also force
  // the current leaf in, so the active position stays visible even if its kind is hidden
  // (e.g. the leaf is a tool result). The explicit user-only / labeled-only filters are
  // deliberate narrow views — don't inject an off-category leaf into them.
  const forceLeaf = mode === "default";
  const visible = new Set<string>();
  for (const n of nodes) {
    if (
      (passesFilter(n, mode) || (forceLeaf && n.id === leafId)) &&
      matchesSearch(n)
    )
      visible.add(n.id);
  }
  if (visible.size === 0) return [];

  // Re-attach each visible node to its nearest visible ancestor, preserving input order
  // within a parent (we re-sort below). Input order is the server's DFS, so siblings of a
  // branch arrive grouped.
  const nearestVisibleAncestor = (id: string): string | null => {
    let cur = byId.get(id)?.parentId ?? null;
    while (cur != null) {
      if (visible.has(cur)) return cur;
      cur = byId.get(cur)?.parentId ?? null;
    }
    return null;
  };
  const childrenOf = new Map<string | null, string[]>();
  for (const n of nodes) {
    if (!visible.has(n.id)) continue;
    const parent = nearestVisibleAncestor(n.id);
    const arr = childrenOf.get(parent);
    if (arr) arr.push(n.id);
    else childrenOf.set(parent, [n.id]);
  }

  // Order siblings: the active branch first (there's at most one active child per branch
  // point), then oldest-first by timestamp — matching pi.
  const sortChildren = (ids: string[]): string[] =>
    [...ids].sort((a, b) => {
      const aActive = activePath.has(a) ? 0 : 1;
      const bActive = activePath.has(b) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      const ta = byId.get(a)?.ts ?? "";
      const tb = byId.get(b)?.ts ?? "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

  const rows: TreeRow[] = [];
  const visit = (
    id: string,
    depth: number,
    rails: boolean[],
    connectorCol: number,
    isLast: boolean,
  ): void => {
    const node = byId.get(id);
    if (!node) return;
    rows.push({
      node,
      depth,
      rails: rails.slice(),
      connectorCol,
      isLast,
      onActivePath: activePath.has(id),
      isLeaf: id === leafId,
    });
    const kids = sortChildren(childrenOf.get(id) ?? []);
    if (kids.length === 1) {
      // Continuation: stay at the same depth, carry the same rails, no connector.
      visit(kids[0]!, depth, rails, -1, false);
    } else if (kids.length > 1) {
      // Branch point: children indent one level; each draws ├/└ at the new column. A
      // child's descendants keep the branch rail iff that child isn't the last sibling.
      kids.forEach((kid, i) => {
        const last = i === kids.length - 1;
        const childRails = rails.slice();
        childRails[depth] = !last;
        visit(kid, depth + 1, childRails, depth, last);
      });
    }
  };

  // Roots (visible nodes with no visible ancestor). One root is the normal case; multiple
  // roots (alternate opening prompts after re-editing the first message) stack at depth 0.
  for (const root of sortChildren(childrenOf.get(null) ?? [])) {
    visit(root, 0, [], -1, false);
  }
  return rows;
}

/** Gutter glyph for one column of a row — drives the CSS connector rendering. */
export type GutterKind = "rail" | "tee" | "corner" | "blank";

export function gutterKind(row: TreeRow, col: number): GutterKind {
  if (col === row.connectorCol) return row.isLast ? "corner" : "tee";
  return row.rails[col] ? "rail" : "blank";
}
