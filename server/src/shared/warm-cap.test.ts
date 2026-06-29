import { describe, expect, test } from "bun:test";
import { evictionPlan } from "./warm-cap.js";

describe("evictionPlan", () => {
  test("no eviction when within the cap", () => {
    expect(evictionPlan(["a", "b", "c"], "c", 8)).toEqual([]);
  });

  test("evicts the oldest when over the cap", () => {
    expect(evictionPlan(["a", "b", "c"], "c", 2)).toEqual(["a"]);
  });

  test("evicts multiple oldest to reach the cap", () => {
    expect(evictionPlan(["a", "b", "c", "d"], "d", 2)).toEqual(["a", "b"]);
  });

  test("never evicts the protected (about-to-focus) id", () => {
    // "a" is oldest, but it's the protected id, so "b" goes instead.
    expect(evictionPlan(["a", "b", "c"], "a", 2)).toEqual(["b"]);
  });

  test("cap <= 0 means unbounded", () => {
    expect(evictionPlan(["a", "b", "c"], "a", 0)).toEqual([]);
    expect(evictionPlan(["a", "b", "c"], "a", -1)).toEqual([]);
  });
});
