// clampScale is the pure core of font-scale.ts (snap-to-step + clamp + NaN fallback).
// The rest of that file is localStorage/DOM-bound, but clampScale is the logic that
// decides what zoom level actually applies — a regression (wrong step grid, wrong
// bounds, NaN→0 instead of →1) would silently break the zoom control. The DOM-bound
// getFontScale/applyFontScale/setFontScale stay covered by the e2e + manual use; this
// pins the pure transform the persisted value flows through.

import { describe, expect, test } from "bun:test";
import { MAX_SCALE, MIN_SCALE, STEP, clampScale } from "./font-scale.js";

describe("clampScale", () => {
  test("clamps above MAX_SCALE", () => {
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(MAX_SCALE + 0.5)).toBe(MAX_SCALE);
  });

  test("clamps below MIN_SCALE", () => {
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(-10)).toBe(MIN_SCALE);
  });

  test("passes through an in-range value already on the step grid", () => {
    // Only grid-aligned values pass through unchanged. Note MIN_SCALE (0.85) and
    // MAX_SCALE (1.7) are NOT on the 1/16 grid (0.85/0.0625=13.6, 1.7/0.0625=27.2),
    // so they snap — only to-grid values like 1, 1+STEP, 1-ST=(0.9375) are fixed points.
    expect(clampScale(1)).toBe(1);
    expect(clampScale(1 + STEP)).toBe(1 + STEP);
    expect(clampScale(1 - STEP)).toBe(1 - STEP);
  });

  test("snaps an off-grid in-range value to the nearest STEP multiple", () => {
    // STEP = 0.0625 (1/16). Math.round rounds half-up, so a value exactly halfway
    // between two grid points goes to the higher one.
    const justBelow = 1 - STEP * 0.4; // ~0.975 → nearer to 1 than to 1-STEP
    const justAbove = 1 + STEP * 0.4; // ~1.025 → nearer to 1 than to 1+STEP
    expect(clampScale(justBelow)).toBe(1);
    expect(clampScale(justAbove)).toBe(1);
    // A value clearly between 1 and 1+STEP snaps to the nearer of the two.
    expect(clampScale(1 + STEP * 0.9)).toBe(1 + STEP);
    expect(clampScale(1 + STEP * 0.1)).toBe(1);
  });

  test("non-finite input falls back to 1 (the default), never 0 or a degenerate scale", () => {
    // The !Number.isFinite guard catches NaN, +Inf, and -Inf alike — all map to 1 so
    // a corrupt/persisted-Infinity value never zooms the transcript to a degenerate scale.
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampScale(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  test("every result lies within [MIN_SCALE, MAX_SCALE] and is grid-aligned OR a bound", () => {
    // Property-style sweep: no input escapes the bounds. snap-then-clamp means a result
    // snapped above MAX (or below MIN) is clamped to the bound, which is itself OFF the
    // STEP grid (1.7/0.0625 = 27.2, 0.85/0.0625 = 13.6) — so the invariant is
    // "on-grid OR equals a bound", not "always on-grid".
    const onGrid = (r: number) =>
      Math.abs(r / STEP - Math.round(r / STEP)) < 1e-9;
    const samples = [
      0.5, 0.8, 0.9, 1.0, 1.1, 1.3, 1.5, 1.7, 2.0, -1, 1.234567, 0.999, 1.001,
    ];
    for (const n of samples) {
      const r = clampScale(n);
      expect(r).toBeGreaterThanOrEqual(MIN_SCALE);
      expect(r).toBeLessThanOrEqual(MAX_SCALE);
      expect(onGrid(r) || r === MIN_SCALE || r === MAX_SCALE).toBe(true);
    }
  });
});
