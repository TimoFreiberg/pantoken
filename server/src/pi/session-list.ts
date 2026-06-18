// Merging the two sources the session list draws from: sessions persisted on disk
// (SessionManager.listAll) and warm in-memory sessions not yet written there. pi only
// flushes a session's .jsonl after its first assistant message, so a just-created
// session lives only in the warm pool until then — without this merge it would be
// missing from the sidebar despite being the active, focused session. Pure so it can
// be unit-tested without booting a real pi driver.

import type { SessionListEntry } from "@pilot/protocol";
import { contentToText, type HistoryMessage } from "./history-map.js";

/** Combine warm (in-memory) and on-disk session entries, deduped by sessionId. A warm
 *  session that's also on disk keeps its richer disk entry — the warm one is a
 *  placeholder. Warm-only entries come first (a fresh session is the newest); callers
 *  that group/sort (the sidebar) re-order anyway. */
export function mergeSessionLists(
  onDisk: readonly SessionListEntry[],
  warm: readonly SessionListEntry[],
): SessionListEntry[] {
  const onDiskIds = new Set(onDisk.map((e) => e.sessionId));
  const warmOnly = warm.filter((e) => !onDiskIds.has(e.sessionId));
  return [...warmOnly, ...onDisk];
}

/** A one-line sidebar preview for a warm (not-yet-on-disk) session: its first user
 *  message, whitespace-collapsed and capped. pi only writes the .jsonl — and thus a
 *  disk-derived preview — after the first ASSISTANT message, so without this a just-
 *  created session (which has only the opening user turn buffered in memory) shows
 *  "(untitled)" in the sidebar until its first response lands. Empty string when no
 *  user message is present yet. */
export function firstUserPreview(
  messages: readonly HistoryMessage[],
  cap = 200,
): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "";
  return contentToText(first.content).replace(/\s+/g, " ").trim().slice(0, cap);
}
