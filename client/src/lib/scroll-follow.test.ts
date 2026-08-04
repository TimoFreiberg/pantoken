import { describe, expect, test } from "vitest";
import { nextPinned } from "./scroll-follow.js";

// The pin decision for the transcript scroller. Extracted from Transcript.svelte's
// onScroll so the rule is unit-testable in isolation. Input-gating ensures only
// user-input events (wheel, touch, keyboard, scrollbar drag) can un-pin, so
// programmatic scrolls structurally cannot false-un-pin. See scroll-follow.ts
// for the full rationale.

const BOTTOM = 30; // gap < 80: at the bottom zone
const SHORT = 200; // gap ≥ 80: short of the bottom

/** A convenience default so each test only spells the fields it cares about. */
const BASE = {
  prevPinned: true,
  prevTop: 1000,
  top: 1000,
  gap: SHORT,
  userScrolling: false,
  pointerDownOnScroller: false,
} as const;

describe("nextPinned", () => {
  test("strict downward movement into the bottom zone → re-pins", () => {
    // A reader who is scrolled up can return to the live tail without needing a
    // separate explicit bottom action.
    expect(
      nextPinned({ ...BASE, prevPinned: false, prevTop: 400, top: 1000, gap: BOTTOM }),
    ).toBe(true);
    // The re-pin is input-independent, including while a user-scroll flag is active.
    expect(
      nextPinned({
        ...BASE,
        prevPinned: false,
        userScrolling: true,
        prevTop: 990,
        top: 1000,
        gap: BOTTOM,
      }),
    ).toBe(true);
  });

  test("stationary or upward movement in the bottom zone does not auto-pin", () => {
    expect(
      nextPinned({ ...BASE, prevPinned: false, prevTop: 1000, top: 1000, gap: BOTTOM }),
    ).toBe(false);
    expect(
      nextPinned({ ...BASE, userScrolling: true, prevTop: 1000, top: 1000, gap: BOTTOM }),
    ).toBe(true);
    expect(
      nextPinned({
        ...BASE,
        prevPinned: false,
        userScrolling: true,
        prevTop: 1050,
        top: 1010,
        gap: BOTTOM,
      }),
    ).toBe(false);
    expect(
      nextPinned({ ...BASE, prevPinned: false, prevTop: 400, top: 1000, gap: 80 }),
    ).toBe(false);
  });

  test("content grew under a pinned viewport (gap opens, scrollTop unchanged) → STAYS pinned", () => {
    // A snapToBottom chase frame landed, then scrollHeight grew (a collapsing work
    // block / streaming delta settled), so gap is now ≥ 80 while scrollTop is
    // unchanged. No user-input event fired → userScrolling is false → the input gate
    // holds the pin.
    expect(nextPinned({ ...BASE, top: 1000, gap: SHORT })).toBe(true);
  });

  test("content grew and the chase nudged scrollTop up slightly → STAYS pinned", () => {
    // Same race, but the chase frame's re-assertion moved scrollTop up a hair (still
    // short of the new bottom). No user input → the input gate holds the pin.
    expect(nextPinned({ ...BASE, prevTop: 1000, top: 1005, gap: SHORT })).toBe(true);
  });

  test("a genuine user scroll-up (userScrolling) → un-pins immediately", () => {
    // THE CORE NEW BEHAVIOR: userScrolling is true (a wheel/touch/keyboard event
    // fired) and scrollTop decreased, so the pin turns off even inside the bottom zone.
    expect(
      nextPinned({ ...BASE, userScrolling: true, prevTop: 1000, top: 400, gap: SHORT }),
    ).toBe(false);
    // Even from an un-pinned state, keep it un-pinned (no re-pin short of the bottom).
    expect(
      nextPinned({
        ...BASE,
        prevPinned: false,
        userScrolling: true,
        prevTop: 400,
        top: 300,
        gap: SHORT,
      }),
    ).toBe(false);
  });

  test("userScrolling: false (programmatic scroll) + top < prevTop → STAYS pinned", () => {
    // AC.2: a programmatic scroll (ResizeObserver re-assert, content-shrink clamp,
    // settleScroll) lowers scrollTop but never sets userScrolling → the input gate
    // holds the pin. This is the structural guarantee that replaces the old
    // scrollHeight discriminator.
    expect(
      nextPinned({ ...BASE, userScrolling: false, prevTop: 1000, top: 400, gap: SHORT }),
    ).toBe(true);
  });

  test("userScrolling: true but scrolled DOWN (top ≥ prevTop) → STAYS pinned", () => {
    // The user scrolled down, not up — no un-pin (they're heading toward the bottom,
    // not away from it).
    expect(
      nextPinned({ ...BASE, userScrolling: true, prevTop: 400, top: 1000, gap: SHORT }),
    ).toBe(true);
  });

  test("pointerDownOnScroller: true (scrollbar drag) + top < prevTop → un-pins", () => {
    // Scrollbar drag: no wheel/touch event fires, but the pointer is down on the
    // scroller and a scroll followed. Treated as user-initiated → un-pin.
    expect(
      nextPinned({
        ...BASE,
        userScrolling: false,
        pointerDownOnScroller: true,
        prevTop: 1000,
        top: 400,
        gap: SHORT,
      }),
    ).toBe(false);
  });

  test("a small input-gated upward nudge within the bottom zone → un-pins", () => {
    // Proximity does not protect a pinned viewport from an actual upward user movement,
    // however small.
    expect(
      nextPinned({
        ...BASE,
        userScrolling: true,
        prevTop: 1000,
        top: 990,
        gap: BOTTOM,
      }),
    ).toBe(false);
  });

  test("an upward movement within the bottom zone without input → holds", () => {
    // Layout changes and content-shrink clamps still cannot false-unpin.
    expect(
      nextPinned({ ...BASE, prevTop: 1000, top: 990, gap: BOTTOM }),
    ).toBe(true);
  });

  test("session switch to a shorter live session (scrollTop clamps down to the bottom) → STAYS pinned", () => {
    // prevTop is component-scoped, so a switch from a tall scrolled-down session
    // (prevTop ≈ 5000) to a shorter live session whose bottom sits at top ≈ 700 fires a
    // scroll event with top < prevTop. But the DOM swap clamps scrollTop to the new max,
    // so the viewport landed AT the new bottom (gap < 80). With no input signal, the
    // reducer preserves the prior pinned state despite the stale comparison. The
    // Transcript.svelte restore effect also resets lastScrollTop = 0 at every switch.
    expect(
      nextPinned({ ...BASE, prevTop: 5000, top: 700, gap: BOTTOM }),
    ).toBe(true);
  });

  test("session switch to a TALLER live session, first chase frame lands short → STAYS pinned", () => {
    // The directional reducer does not close this case by itself: switching to a taller
    // live session whose first chase frame lands short, with a stale-higher prevTop carried
    // from the prior session. The fix is in the WIRING: Transcript.svelte's restore
    // effect resets lastScrollTop = 0 at the switch, so prevTop = 0 here, and
    // `top < 0` is impossible → the frame holds pinned. This test pins the wiring
    // invariant by asserting the reset-fed shape stays pinned.
    expect(nextPinned({ ...BASE, prevTop: 0, top: 2500, gap: 400 })).toBe(true);
    // And the stale-prevTop shape (higher prevTop, but no user-input signal)
    // also holds pinned — the input gate doesn't fire without userScrolling.
    expect(
      nextPinned({ ...BASE, prevTop: 5000, top: 2500, gap: 400 }),
    ).toBe(true);
  });

  test("session switch restoring a scrolled-up reading spot → un-pins", () => {
    // The restore effect sets pinned=false explicitly and snaps to a saved mid-transcript
    // spot, then resets lastScrollTop = 0; the chase frames then fire onScroll. With
    // prevTop = 0 the unpin branch can't fire (top < 0 is impossible), but the rule still
    // returns the explicit prevPinned=false via the third arm — so the restore STAYS
    // un-pinned as intended.
    expect(
      nextPinned({ ...BASE, prevPinned: false, prevTop: 0, top: 200, gap: SHORT }),
    ).toBe(false);
  });

  // ── Content-shrink: input-gating replaces the scrollHeight discriminator ──────────

  test("content shrank with scrollTop clamp-down and NO user input → STAYS pinned", () => {
    // The old #86 bug: a thinking block unmounts after its text arrives, scrollHeight
    // drops. The ResizeObserver re-asserts to the new (shorter) bottom, the browser
    // clamps scrollTop down, gap briefly ≥ 80. Under input-gating, userScrolling is
    // false (no user-input event fired) → the input gate holds the pin. No
    // scrollHeight discriminator needed.
    expect(
      nextPinned({ ...BASE, prevTop: 1000, top: 800, gap: SHORT }),
    ).toBe(true);
  });

  test("content shrank and gap is large with NO user input → STAYS pinned", () => {
    // The nothingness case: scrollTop is past the new bottom (gap calculated as
    // negative/large while content settles). No user input → stays pinned.
    expect(
      nextPinned({ ...BASE, prevTop: 1000, top: 950, gap: 500 }),
    ).toBe(true);
  });

  test("content grew (gap ≥ 80) with NO user input → STAYS pinned", () => {
    // The user-prompt-sent case: new content grew below the fold, gap opens because
    // scrollHeight increased while scrollTop is unchanged. No user input → holds
    // pinned so the streaming-pin effect keeps chasing the new bottom.
    expect(
      nextPinned({ ...BASE, prevTop: 1000, top: 1000, gap: SHORT }),
    ).toBe(true);
  });
});
