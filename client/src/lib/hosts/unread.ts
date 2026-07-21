// Pure unread/unseen transition rules for host activity.
//
// These track per-host activity from `sessionStatus` messages WITHOUT
// inspecting or folding background transcript events. The coordinator uses
// these to decide when to show the gold "unseen" dot on an inactive host.
//
// Rules (task brief):
//   1. The first sessionStatus for a newly connected host establishes a baseline
//      and cannot set unseen by itself.
//   2. While inactive: a transition into "done" (a session leaving runningIds),
//      or a new/updated attention item with phase "waiting" or "failed", sets
//      unseen = true.
//   3. waiting and failed derive from current attention entries; they survive
//      selection (are NOT cleared merely because the host becomes active).
//   4. clearOnSelect sets unseen = false but preserves waiting/failed.
//   5. running derives from non-empty runningIds or initializingIds.

import type { SessionAttention } from "@pantoken/protocol";

/** Per-host unread/activity state, tracked across sessionStatus messages. */
export interface UnreadState {
  running: boolean;
  unseen: boolean;
  waiting: boolean;
  failed: boolean;
  /** True once the first sessionStatus has established a baseline. */
  baselined: boolean;
  /** The set of running session ids from the previous sessionStatus, so
   *  transitions to done (a session leaving runningIds) can be detected. */
  prevRunningIds: ReadonlySet<string>;
}

/** The initial unread state for a host that has not yet received its first
 *  sessionStatus. */
export function initialUnreadState(): UnreadState {
  return {
    running: false,
    unseen: false,
    waiting: false,
    failed: false,
    baselined: false,
    prevRunningIds: new Set(),
  };
}

/** Derive waiting/failed flags from the current attention entries. */
function deriveAttention(
  attention: readonly SessionAttention[],
): { waiting: boolean; failed: boolean } {
  let waiting = false;
  let failed = false;
  for (const item of attention) {
    if (item.phase === "waiting") waiting = true;
    if (item.phase === "failed") failed = true;
  }
  return { waiting, failed };
}

/** Apply a sessionStatus update to a host's unread state.
 *
 *  @param prev - The previous unread state.
 *  @param status - The sessionStatus fields (runningIds, initializingIds, attention).
 *  @param isActiveHost - Whether this host is the currently selected/active host.
 *    Inactive hosts can accumulate unseen; active hosts do not.
 *  @returns The new unread state. */
export function applySessionStatus(
  prev: UnreadState,
  status: {
    runningIds: readonly string[];
    initializingIds?: readonly string[];
    attention?: readonly SessionAttention[];
  },
  isActiveHost: boolean,
): UnreadState {
  const attention = status.attention ?? [];
  const { waiting, failed } = deriveAttention(attention);

  const nextRunningIds = new Set(status.runningIds);
  const hasInitializing = status.initializingIds
    ? status.initializingIds.length > 0
    : false;
  const running = nextRunningIds.size > 0 || hasInitializing;

  // Rule 1: first sessionStatus establishes a baseline; never sets unseen.
  if (!prev.baselined) {
    return {
      running,
      unseen: false,
      waiting,
      failed,
      baselined: true,
      prevRunningIds: nextRunningIds,
    };
  }

  // Rule 2: while inactive, a session leaving runningIds (running → done) sets unseen.
  // We only set unseen if there WAS a running session that is now gone.
  let unseen = prev.unseen;
  if (!isActiveHost) {
    // Detect sessions that were running before but are no longer running now.
    const completedSessions = [...prev.prevRunningIds].filter(
      (id) => !nextRunningIds.has(id),
    );
    if (completedSessions.length > 0) {
      unseen = true;
    }
    // A new waiting or failed attention item on an inactive host also sets unseen,
    // because the operator should be alerted to it.
    if (waiting && !prev.waiting) unseen = true;
    if (failed && !prev.failed) unseen = true;
  }

  return {
    running,
    unseen,
    waiting,
    failed,
    baselined: true,
    prevRunningIds: nextRunningIds,
  };
}

/** Selecting a host clears ordinary unseen after bootstrap/seed is adopted
 *  (rule 4). waiting/failed survive selection (rule 3).
 *
 *  @param prev - The current unread state.
 *  @returns The new unread state with unseen cleared. */
export function clearOnSelect(prev: UnreadState): UnreadState {
  return {
    ...prev,
    unseen: false,
  };
}
