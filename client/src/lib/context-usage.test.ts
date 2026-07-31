import { describe, expect, it } from "vitest";
import { clampContextPercent } from "./context-usage.js";

describe("clampContextPercent", () => {
  it("clamps over-window percents to 100", () => {
    expect(clampContextPercent(200)).toBe(100);
    expect(clampContextPercent(150.5)).toBe(100);
  });

  it("passes through below-window percents unrounded", () => {
    expect(clampContextPercent(87.6)).toBe(87.6);
    expect(clampContextPercent(0)).toBe(0);
    expect(clampContextPercent(23.6)).toBe(23.6);
  });

  it("passes through null unchanged", () => {
    expect(clampContextPercent(null)).toBeNull();
  });
});
