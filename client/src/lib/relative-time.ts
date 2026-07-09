// Compact "time since" labels for the session list. Pure so it can be unit-tested
// without the DOM; the Sidebar feeds it `updatedAt` + a `now` snapshot.

// A floor below which a timestamp is implausible rather than genuinely ancient — pantoken
// itself didn't exist yet, so nothing real predates it. Guards against the epoch-ish
// "1970-01-01" fallback the server uses for a cold session with an empty/missing
// created_at (server-rs/pantoken-server/src/polytoken/sessions_registry.rs), which would
// otherwise render as a literal "56y ago" in the sidebar. A fixed calendar date rather than
// an age relative to `now`: it never starts swallowing genuinely old-but-real sessions as
// the app (and its data) age past whatever "N years" a relative floor would pick.
const ANCIENT_CUTOFF_MS = Date.parse("2020-01-01T00:00:00Z");

/** Compact relative-time label — "just now", "15m ago", "3h ago", "2d ago", "5w ago",
 *  "8mo ago", "2y ago". An unparseable, empty, or implausibly ancient (pre-cutoff, see
 *  `ANCIENT_CUTOFF_MS`) timestamp yields "" so the caller can render nothing rather than a
 *  bogus "NaN ago" / "56y ago". Future timestamps clamp to "just now". */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t < ANCIENT_CUTOFF_MS) return "";
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

/** Ultra-compact "time since" for the sidebar's single-line slot — "now", "15m", "3h",
 *  "2d", "5w", "8mo", "2y". Same buckets as `relativeTime`, just without the " ago" so
 *  it fits the tight right-aligned slot beside the title. The full form is kept for the
 *  hover tooltip. Empty, unparseable, or implausibly ancient (see `ANCIENT_CUTOFF_MS`)
 *  timestamps yield "". */
export function compactTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t < ANCIENT_CUTOFF_MS) return "";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(day / 365)}y`;
}
