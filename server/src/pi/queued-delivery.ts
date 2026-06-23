// Reconciles where a queued (steer/follow-up) message lands in the transcript.
//
// The problem it solves: when the agent is mid-run and the user sends a message, pi
// *queues* it (steer → delivered at the next turn boundary; followUp → delivered once the
// agent would stop) and ACKs immediately. If pilot inserts the user bubble at ACK time it
// lands where the message was *queued*, not where pi actually *runs* it — minutes too
// early. groupTurns then splits the turn at that early bubble, pushing the prior turn's
// real final response into a later turn's collapsible "work" block, where it vanishes
// behind "Worked for Ns". (A reload hid the bug because pi's on-disk history records the
// message at its true delivery position; only the live fold was wrong.)
//
// The fix: pilot suppresses the ACK-time bubble for queued sends and instead synthesizes
// the user turn when pi *delivers* the message — which surfaces as a `role:"user"`
// `message_start`. This tracker gates that: it counts queued-but-undelivered messages so a
// delivery's message_start is recognised, while a normal first prompt's identical
// message_start (count 0 — its bubble already shows via the optimistic send path) is left
// alone. Per warm session, since deliveries are per-session.
//
// Why a plain count suffices (no id correlation): during an active run the ONLY
// `role:"user"` message_start events are queued deliveries — the run-opening prompt fires
// its start before any queuing is possible (count still 0), and tool results don't emit a
// user message_start. So FIFO counting can't mistake one user turn for another. The queue
// tray reconciles itself via pi's drain `queue_update`, so we don't need the message's id.

/** The shape of a raw pi session event this tracker inspects. Structural, not pi's full
 *  union, so the tracker stays decoupled from pi-ai's types. */
export interface MaybeMessageStart {
  type?: string;
  message?: { role?: string };
}

export class QueuedDeliveryTracker {
  private pending = 0;

  /** A queued (steer/follow-up) message was accepted by pi but not yet delivered. */
  onQueued(): void {
    this.pending++;
  }

  /**
   * True when `ev` is the delivery of a queued message — a `role:"user"` `message_start`
   * while deliveries are outstanding — and the caller should synthesize a user turn for it
   * (consuming one pending slot). False for everything else: a non-user/non-start event, or
   * a `role:"user"` start with nothing pending (a normal first prompt, already shown).
   */
  isDelivery(ev: MaybeMessageStart): boolean {
    if (
      this.pending > 0 &&
      ev.type === "message_start" &&
      ev.message?.role === "user"
    ) {
      this.pending--;
      return true;
    }
    return false;
  }

  /** Undelivered queued messages are gone (abort clears pi's queues; clearQueue/Alt+Up
   *  restores them to the editor). Drop the count so a later first prompt's message_start
   *  isn't mistaken for a delivery. */
  reset(): void {
    this.pending = 0;
  }

  /** Outstanding queued-but-undelivered count. Exposed for assertions/diagnostics. */
  get outstanding(): number {
    return this.pending;
  }
}
