// Readline-style prompt history navigation for the composer. Pure helpers — the cursor
// math and list shaping live here (testable in isolation); the DOM glue (caret placement,
// store reads) stays in Composer.svelte.
//
// History is ordered oldest→newest. A navigation cursor is either `null` (showing the
// live work-in-progress draft) or an index into the history array. ArrowUp walks toward
// older entries; ArrowDown walks back toward newer ones and finally to the live draft.

/** Next cursor position for an Up/Down step over a history of `len` entries.
 *
 *  - `undefined` → no-op (let the textarea handle the key normally): empty history, or
 *    already at the oldest entry (Up), or not currently navigating (Down).
 *  - `null` → step back down past the newest entry: restore the saved live draft.
 *  - a number → show `history[n]`.
 */
export function nextHistoryIndex(
  len: number,
  index: number | null,
  dir: "up" | "down",
): number | null | undefined {
  if (len === 0) return undefined;
  if (dir === "up") {
    if (index === null) return len - 1; // enter at the newest entry
    if (index <= 0) return undefined; // already at the oldest — nothing older
    return index - 1;
  }
  // down
  if (index === null) return undefined; // not navigating — Down is a plain caret move
  if (index >= len - 1) return null; // past the newest — back to the live draft
  return index + 1;
}

/** True when the caret sits on the first logical line (no newline before it) — the
 *  gate for ArrowUp to recall history rather than move the caret up a line. An empty
 *  field satisfies this trivially. */
export function caretOnFirstLine(value: string, caret: number): boolean {
  return value.lastIndexOf("\n", caret - 1) === -1;
}

/** True when the caret sits on the last logical line (no newline at/after it) — the gate
 *  for ArrowDown to walk history forward rather than move the caret down a line. */
export function caretOnLastLine(value: string, caret: number): boolean {
  return value.indexOf("\n", caret) === -1;
}

/** Collapse runs of identical adjacent entries. Used when merging the transcript's user
 *  messages with the local submit log: a just-sent prompt lives in the log immediately and
 *  reappears in the transcript once the server folds it, which would otherwise double it. */
export function dedupeConsecutive(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of list) if (out[out.length - 1] !== item) out.push(item);
  return out;
}
