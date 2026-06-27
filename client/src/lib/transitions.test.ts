// revealDuration is the pure core of the reveal transition: the effective duration
// given the reduced-motion preference + caller params. Split out of reveal() — which
// called the private prefersReducedMotion() (window.matchMedia) inline, making the
// duration decision untestable without a DOM — mirroring theme.ts's resolveThemeMode /
// notify.ts's shouldNotify pattern (thread the env-dependent boolean in as a param).
// reveal() itself stays DOM-bound (calls svelte's slide); this pins the decision logic.

import { describe, expect, test } from "bun:test";
import { REVEAL_MS, revealDuration } from "./transitions.js";

describe("revealDuration (pure)", () => {
  test("reduced motion forces 0 (instant snap) regardless of caller duration", () => {
    // The accessibility courtesy: reduced-motion users never get a glide, even if a
    // caller asked for a long one.
    expect(revealDuration({}, true)).toBe(0);
    expect(revealDuration({ duration: 2000 }, true)).toBe(0);
  });

  test("without reduced motion, falls back to REVEAL_MS when no duration given", () => {
    expect(revealDuration({}, false)).toBe(REVEAL_MS);
    expect(revealDuration({ duration: undefined }, false)).toBe(REVEAL_MS);
  });

  test("without reduced motion, the caller's explicit duration wins", () => {
    expect(revealDuration({ duration: 300 }, false)).toBe(300);
    expect(revealDuration({ duration: 0 }, false)).toBe(0);
  });

  test("reduced motion takes precedence over a caller duration of 0 (no-op either way, pins precedence)", () => {
    // Both yield 0, but for different reasons — pins that reduced-motion short-circuits
    // BEFORE reading params, so a future change that reads params first can't regress it.
    expect(revealDuration({ duration: 500 }, true)).toBe(0);
  });
});
