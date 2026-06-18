// Compact "time since" labels for the session list. Pure so it can be unit-tested
// without the DOM; the Sidebar feeds it `updatedAt` + a `now` snapshot.

/** Compact relative-time label — "just now", "15m ago", "3h ago", "2d ago", "5w ago",
 *  "8mo ago", "2y ago". An unparseable or empty timestamp yields "" so the caller can
 *  render nothing rather than a bogus "NaN ago". Future timestamps clamp to "just now". */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}
