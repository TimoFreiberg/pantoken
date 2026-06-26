// Per-session transcript scroll position, persisted to localStorage so switching away
// from a warmed session and back restores where you were reading instead of always
// jumping to the live tail. Mirrors the draft/font-scale/theme persistence shape.
//
// What we store: a RATIO (scrollTop / scrollHeight), not a raw pixel offset. Content
// can grow between visits (the agent appended a turn while the session was backgrounded,
// images decoded, markstream finalized), so a raw scrollTop would land at the wrong
// spot. A ratio places you at the same relative position in the transcript — close
// enough that you re-orient instantly, and it clamps to the new scrollHeight.
//
// What we DON'T restore: a session that's unread (new content arrived while away) or
// running/initializing (a live turn is in flight). Both want the live bottom, not the
// stale reading spot. See Transcript.svelte's switch effect for the gate.

const KEY = "pilot.scrollPositions";

type SavedPosition = { ratio: number; at: number };

export function loadScrollPositions(): Record<string, SavedPosition> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, SavedPosition> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Tolerate older/corrupt entries: a valid record has a numeric ratio in [0,1].
      if (v && typeof v === "object") {
        const r = (v as { ratio?: unknown }).ratio;
        if (typeof r === "number" && r >= 0 && r <= 1) {
          out[k] = {
            ratio: r,
            at: ((v as { at?: unknown }).at as number) ?? Date.now(),
          };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function persistScrollPositions(
  map: Record<string, SavedPosition>,
): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Storage full / unavailable (private mode) — positions stay in-memory this session.
  }
}

/** Record where the user is reading in `sessionId`. `scrollTop`/`scrollHeight` from the
 *  scroller; a ratio is derived so a later restore survives content growth. A session
 *  pinned to the bottom stores ratio 1 (restores to the live tail). */
export function saveScrollPosition(
  map: Record<string, SavedPosition>,
  sessionId: string,
  scrollTop: number,
  scrollHeight: number,
): Record<string, SavedPosition> {
  if (scrollHeight <= 0) return map;
  const ratio = Math.min(1, Math.max(0, scrollTop / scrollHeight));
  return { ...map, [sessionId]: { ratio, at: Date.now() } };
}

/** Drop a saved position (e.g. when a session is archived/deleted). */
export function forgetScrollPosition(
  map: Record<string, SavedPosition>,
  sessionId: string,
): Record<string, SavedPosition> {
  if (!(sessionId in map)) return map;
  const next = { ...map };
  delete next[sessionId];
  return next;
}

/** The target scrollTop for restoring `sessionId`, given the CURRENT scrollHeight.
 *  Null when there's nothing saved (caller falls back to the live bottom). The ratio is
 *  clamped to the new height so growth never lands past the end. */
export function restoreScrollTop(
  map: Record<string, SavedPosition>,
  sessionId: string,
  scrollHeight: number,
): number | null {
  const saved = map[sessionId];
  if (!saved) return null;
  return Math.min(scrollHeight, Math.max(0, saved.ratio * scrollHeight));
}
