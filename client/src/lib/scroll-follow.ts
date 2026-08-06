// The pinned-to-bottom decision for the transcript scroller, extracted pure so the
// rule is unit-testable in isolation (no DOM, no store, no Svelte effect timing).
//
// INPUT-GATING: the pin is turned OFF only by explicit user-input events — wheel,
// touch drag, keyboard scroll keys, prompt-map jumps, and scrollbar drag.
// Programmatic scrolls (ResizeObserver re-asserts, settleScroll, find-in-transcript,
// content-shrink clamps) structurally cannot false-un-pin because they never fire
// user-input events.
//
// THE GATE: `userScrolling` is set true by blessed-input event handlers on `.scroller`
// (onwheel, ontouchstart, onkeydown for scroll keys) and cleared after scrolling
// settles (~150ms). `pointerDownOnScroller` covers the scrollbar-drag case (no
// wheel/touch event fires, but the pointer is down on the scrollbar and a
// scroll follows). It's gated on `e.target === scroller` so content clicks
// (which target child elements) don't set it. Both are OR'd: either is a
// user-initiated scroll. The un-pin decision then requires BOTH a
// user-input signal AND a genuine upward move (`top < prevTop`).
//
// WHY the direction check is separate from the input gate:
//   - A strict downward movement into the bottom zone (`gap < 80`) is enough to re-pin,
//     regardless of whether the movement came from user input or layout settling.
//   - An upward movement un-pins only when an input signal is present. It un-pins
//     immediately, even when the movement remains within the bottom zone, while
//     programmatic/content-layout movement continues to hold the prior state.
//
// Session switch: `prevTop` is component-scoped (not per-session), so it is stale across
// a switch. A shorter-session clamp may move upward into the bottom zone, but without an
// input signal the reducer holds the prior state. The taller-session case is closed in
// the WIRING: Transcript.svelte resets `lastScrollTop = 0` at the switch, so the
// cross-session comparison can only re-pin or hold, never spuriously un-pin.

export type PinnedInput = {
  /** Whether the viewport was pinned before this scroll event. */
  prevPinned: boolean;
  /** `scrollTop` seen by the PREVIOUS onScroll call (component-scoped, not per-session). */
  prevTop: number;
  /** `scrollTop` for THIS scroll event. */
  top: number;
  /** `scrollHeight - scrollTop - clientHeight` for THIS scroll event. */
  gap: number;
  /** Whether a user-input event (wheel/touch/keyboard) marked scrolling recently. */
  userScrolling: boolean;
  /** Whether the pointer is down on the scroller (scrollbar drag — no wheel/touch fires). */
  pointerDownOnScroller: boolean;
};

/** Whether the transcript should stay stuck to the live bottom after a scroll event.
 *
 *  - Re-pin only after a strict downward movement into the bottom zone (`top > prevTop`
 *    and `gap < 80`). This is input-independent, so an unpinned reader can scroll back
 *    down to the live tail.
 *  - After the existing input gate (`userScrolling || pointerDownOnScroller`), un-pin on
 *    any strict upward movement (`top < prevTop`), including a movement that remains
 *    inside the bottom zone.
 *  - Otherwise hold the prior pin. Stationary events and upward programmatic/content-
 *    layout movement therefore cannot change the state. */
export function nextPinned({
  prevPinned,
  prevTop,
  top,
  gap,
  userScrolling,
  pointerDownOnScroller,
}: PinnedInput): boolean {
  if (top > prevTop && gap < 80) return true;
  if ((userScrolling || pointerDownOnScroller) && top < prevTop) return false;
  return prevPinned;
}
