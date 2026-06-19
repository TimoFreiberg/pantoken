// Parser for the "tasklist" ambient widget.
//
// The tasklist pi extension (~/.pi/agent/extensions/tasklist.ts) pushes its state
// to the host as a plain `string[]` via ui.setWidget("tasklist", lines) — the only
// channel pilot's bridge renders remotely. The lines look like:
//
//   Open Tasks (3):
//     ○ #v23gry: first item
//     ○ #4dhaiz: item numero dos
//
// We don't control the wire shape (the extension is shared with pi's TUI), so we
// recover structure here by matching the per-item line. Detection that "this is a
// tasklist" is done by the widget KEY upstream; this parser only extracts items and
// returns null when nothing parses, so a format drift degrades to the raw monospace
// box rather than an empty pill.

export interface ParsedTask {
  id: string;
  description: string;
}

// `  ○ #id: description` — tolerate the open-circle glyph plus a couple of ASCII
// stand-ins, any leading whitespace, and an optional "#" on the id.
const ITEM = /^\s*[○◯o*-]\s*#?(\S+):\s*(.*)$/u;

/**
 * Parse the tasklist widget's lines into structured tasks. Returns null when no
 * item line matches (empty list, or a format we don't recognize) so callers can
 * fall back to rendering the raw lines.
 */
export function parseTasklist(
  lines: readonly string[] | undefined,
): ParsedTask[] | null {
  if (!lines || lines.length === 0) return null;
  const tasks: ParsedTask[] = [];
  for (const line of lines) {
    const m = ITEM.exec(line);
    const id = m?.[1];
    const description = m?.[2];
    if (id !== undefined && description !== undefined) {
      tasks.push({ id, description: description.trim() });
    }
  }
  return tasks.length > 0 ? tasks : null;
}
