import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RIGHT_SIDEBAR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAIN_MIN_WIDTH,
  MIN_RIGHT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  effectiveWidths,
  parseStoredWidth,
  sanitizeStoredWidth,
} from "./sidebar-width.js";

describe("sidebar width contract", () => {
  test("uses the existing desktop defaults", () => {
    expect(DEFAULT_SIDEBAR_WIDTH).toBe(288);
    expect(DEFAULT_RIGHT_SIDEBAR_WIDTH).toBe(280);
  });
  test("rejects malformed and unsafe stored values", () => {
    for (const value of [null, "", "nope", "NaN", "Infinity", "0", "-4", "3000"]) expect(sanitizeStoredWidth(value)).toBeNull();
    expect(parseStoredWidth(null, 288)).toBe(288);
  });
  test("keeps valid oversized CSS-pixel preferences unchanged", () => {
    expect(sanitizeStoredWidth("1200")).toBe(1200);
    expect(parseStoredWidth("1200", 288)).toBe(1200);
  });
  test("clamps one open panel without rewriting the preference", () => {
    expect(effectiveWidths(1200, 280, 1100, true, false).left).toBe(
      1100 - MAIN_MIN_WIDTH,
    );
    expect(effectiveWidths(1200, 1200, 1100, false, true).right).toBe(
      1100 - MAIN_MIN_WIDTH,
    );
  });
  test("reduces both oversized panels proportionally", () => {
    const result = effectiveWidths(800, 700, 1100, true, true);
    expect(result.left + result.right).toBe(1100 - MAIN_MIN_WIDTH);
    expect(result.left).toBeGreaterThan(MIN_SIDEBAR_WIDTH);
    expect(result.right).toBeGreaterThan(MIN_RIGHT_SIDEBAR_WIDTH);
  });
  test("preserves raw widths when both panels are closed", () => {
    expect(effectiveWidths(500, 600, 500, false, false)).toEqual({ left: 500, right: 600 });
  });
  test("falls back to both minima on an unavoidably narrow viewport", () => {
    expect(effectiveWidths(800, 800, 400, true, true)).toEqual({ left: MIN_SIDEBAR_WIDTH, right: MIN_RIGHT_SIDEBAR_WIDTH });
  });
  test("recomputation is deterministic and CSS-pixel based", () => {
    const first = effectiveWidths(777, 555, 1100, true, true);
    expect(effectiveWidths(777, 555, 1100, true, true)).toEqual(first);
    expect(first.left + first.right).toBeLessThanOrEqual(1100 - MAIN_MIN_WIDTH + 1e-9);
  });
});
