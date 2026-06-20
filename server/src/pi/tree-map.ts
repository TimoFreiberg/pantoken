// Project pi's in-memory session tree (SessionManager.getTree()) into the JSON-safe,
// DOM-free TreeSnapshot the wire carries. We flatten the nested tree depth-first into a
// flat node list (the client rebuilds it from `parentId`) and reduce each entry to a
// one-line preview + a coarse kind, mirroring pi's tree-selector display text without the
// ANSI colour codes (the client styles by kind). The full DAG ships — every entry, every
// branch, abandoned ones included — so the client can filter/flatten it like pi's /tree.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TreeNodeInfo, TreeNodeKind, TreeSnapshot } from "@pilot/protocol";
import { contentToText } from "./history-map.js";

/** Structural view of pi's `SessionTreeNode` (defensive copy from `getTree()`). Declared
 *  locally so we don't depend on the type being re-exported from the package root. */
interface PiTreeNode {
  entry: SessionEntry;
  children: readonly PiTreeNode[];
  label?: string;
}

const PREVIEW_CAP = 200;

const normalize = (s: string): string =>
  s.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CAP);

const textOf = (content: unknown): string =>
  normalize(contentToText(content as Parameters<typeof contentToText>[0]));

/** One entry -> {kind, preview}. Mirrors tree-selector.ts `getEntryDisplayText`, minus the
 *  terminal styling. A tool row shows its tool name (the call's args live on the assistant
 *  entry's content, not the toolResult entry) — fine, since tools are hidden by default. An
 *  assistant turn with only tool calls projects to an empty preview; the client treats that
 *  as a no-text turn and hides it outside the "all" filter. */
function describe(entry: SessionEntry): {
  kind: TreeNodeKind;
  preview: string;
} {
  switch (entry.type) {
    case "message": {
      const msg = entry.message as {
        role?: string;
        content?: unknown;
        command?: string;
        toolName?: string;
      };
      switch (msg.role) {
        case "user":
          return { kind: "user", preview: textOf(msg.content) };
        case "assistant":
          return { kind: "assistant", preview: textOf(msg.content) };
        case "toolResult":
          return { kind: "tool", preview: `[${msg.toolName ?? "tool"}]` };
        case "bashExecution":
          return {
            kind: "bash",
            preview: `[bash] ${normalize(msg.command ?? "")}`,
          };
        default:
          return { kind: "custom", preview: `[${msg.role ?? "message"}]` };
      }
    }
    case "branch_summary":
      return { kind: "branch-summary", preview: normalize(entry.summary) };
    case "compaction":
      return {
        kind: "compaction",
        preview: `[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`,
      };
    case "model_change":
      return { kind: "model-change", preview: `[model: ${entry.modelId}]` };
    case "thinking_level_change":
      return {
        kind: "thinking-change",
        preview: `[thinking: ${entry.thinkingLevel}]`,
      };
    case "label":
      return {
        kind: "label",
        preview: `[label: ${entry.label ?? "(cleared)"}]`,
      };
    case "session_info":
      return {
        kind: "session-info",
        preview: entry.name ? `[title: ${entry.name}]` : "[title]",
      };
    case "custom":
      return { kind: "custom", preview: `[${entry.customType}]` };
    case "custom_message":
      return {
        kind: "custom",
        preview: `[${entry.customType}] ${textOf(entry.content)}`.trim(),
      };
    default:
      return { kind: "custom", preview: "" };
  }
}

/** Flatten a SessionManager's tree into the wire snapshot. Accepts the structural slice we
 *  need so it's trivial to unit-test and doesn't pin the manager's full type. */
export function projectTree(sm: {
  getTree(): readonly PiTreeNode[];
  getLeafId(): string | null;
}): TreeSnapshot {
  const nodes: TreeNodeInfo[] = [];
  const walk = (n: PiTreeNode): void => {
    const { kind, preview } = describe(n.entry);
    nodes.push({
      id: n.entry.id,
      parentId: n.entry.parentId ?? null,
      kind,
      preview,
      ts: n.entry.timestamp,
      label: n.label,
    });
    for (const c of n.children) walk(c);
  };
  for (const root of sm.getTree()) walk(root);
  return { nodes, leafId: sm.getLeafId() };
}
