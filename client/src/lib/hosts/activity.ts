// Pure activity precedence helpers: derive the visual indicator for a host
// from its aggregate activity state.
//
// Precedence (task brief rule 6):
//   connection failure > session attention > unseen > running > quiet
//
// No Svelte, no DOM — pure functions over HostActivity.

import type { HostActivity } from "./types.js";

/** The visual indicator shown for a host in the sidebar/host switcher. */
export type HostIndicator =
  | "offline" // disconnected or unreachable
  | "failed" // connection failure or session failed
  | "waiting" // session waiting for input
  | "unseen" // gold dot: unseen completion
  | "running" // bronze motion: at least one session running
  | "quiet"; // connected and quiet (no indicator)

/** Derive the visual indicator from a host's activity + connection state.
 *
 *  Precedence: offline > failed > waiting > unseen > running > quiet.
 *  A disconnected host always shows offline regardless of activity flags,
 *  because the activity may be stale. */
export function deriveIndicator(
  activity: HostActivity,
  connected: boolean,
): HostIndicator {
  if (!connected) return "offline";
  if (activity.failed) return "failed";
  if (activity.waiting) return "waiting";
  if (activity.unseen) return "unseen";
  if (activity.running) return "running";
  return "quiet";
}

/** Map an indicator to its CSS color token. Colors follow docs/ui-conventions.md:
 *  bronze (--progress) for running, gold (--highlight) for unseen, semantic
 *  warning/danger for failed/waiting, muted for offline, transparent for quiet. */
export function indicatorColor(indicator: HostIndicator): string {
  switch (indicator) {
    case "offline":
      return "var(--muted)";
    case "failed":
      return "var(--danger)";
    case "waiting":
      return "var(--warning)";
    case "unseen":
      return "var(--highlight)";
    case "running":
      return "var(--progress)";
    case "quiet":
      return "transparent";
  }
}
