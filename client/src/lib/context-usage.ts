/**
 * The single canonical clamp for the context-meter percent. The daemon's used
 * token count can legitimately exceed the window (occupancy + output), and
 * `SessionUsage.percent` on the wire is raw — the server clamps it in
 * `usage_from_state`, but the mock driver constructs `SessionUsage` directly
 * and bypasses that — so every client render site clamps here instead of ever
 * showing "200%". The raw truth stays visible via `tokens`/`contextWindow`
 * (the meter popup's "`tokens` / `contextWindow` tokens" line).
 *
 * Returns `null` for `null` (window known, count pending) and clamps to
 * [0, 100]; below-window values pass through unrounded (the ring label applies
 * its own rounding).
 */
export function clampContextPercent(pct: number | null): number | null {
  if (pct === null) return null;
  return Math.min(100, Math.max(0, pct));
}
