import { describe, expect, test } from "vitest";
import {
  calculatePromptIntervals,
  pairPromptTicks,
  projectPromptCluster,
  projectPromptTicks,
  responseFallback,
  responsePreview,
  selectPromptWindow,
  truncatePromptPreview,
} from "./prompt-map.js";

describe("truncatePromptPreview", () => {
  test("handles empty, short, and long prompts", () => {
    expect(truncatePromptPreview("  ")).toBe("");
    expect(truncatePromptPreview("one\n two")).toBe("one two");
    expect(truncatePromptPreview("one two three four five six seven eight nine")).toBe(
      "one two three four five six seven eight…",
    );
  });
});

describe("response previews", () => {
  test("normalizes lines and clamps to three", () => {
    expect(responsePreview(" first  line \n\n second\nthird\nfourth ")).toEqual([
      "first line",
      "second",
      "third",
    ]);
  });

  test("keeps explicit no-final fallbacks", () => {
    expect(responsePreview("")).toEqual([]);
    expect(responseFallback("in-progress")).toBe("Response in progress…");
    expect(responseFallback("none")).toBe("No final response");
  });
});

describe("calculatePromptIntervals", () => {
  test("uses the next prompt and scroll height for the last interval", () => {
    expect(calculatePromptIntervals([100, 300], 250, 100, 700)).toEqual([
      { index: 0, start: 100, end: 300, active: true },
      { index: 1, start: 300, end: 700, active: true },
    ]);
  });

  test("marks multiple intersecting intervals and honors boundaries", () => {
    const result = calculatePromptIntervals([0, 100, 200], 100, 100, 500);
    expect(result.filter((interval) => interval.active).map((interval) => interval.index)).toEqual([
      0, 1, 2,
    ]);
  });
});

describe("selectPromptWindow", () => {
  const base = {
    total: 20,
    availableHeight: 50,
    tickPitch: 10,
    contextPadding: 1,
  };

  test("fits every entry when the transcript is short", () => {
    const result = selectPromptWindow({ ...base, total: 3, activeIndices: [1] });
    expect(result.indices).toEqual([0, 1, 2]);
    expect(result.omittedBefore).toBe(false);
    expect(result.omittedAfter).toBe(false);
  });

  test("selects beginning, middle, and end windows", () => {
    expect(selectPromptWindow({ ...base, activeIndices: [0] }).indices).toEqual([0, 1, 2, 3, 4]);
    expect(selectPromptWindow({ ...base, activeIndices: [10] }).indices).toEqual([8, 9, 10, 11, 12]);
    expect(selectPromptWindow({ ...base, activeIndices: [19] }).indices).toEqual([15, 16, 17, 18, 19]);
  });

  test("uses nearest or stable index when there is no active geometry", () => {
    expect(selectPromptWindow({ ...base, activeIndices: [], nearestIndex: 5 }).primaryIndex).toBe(5);
    expect(selectPromptWindow({ ...base, activeIndices: [], stablePrimaryIndex: 2 }).primaryIndex).toBe(2);
  });

  test("renders every active index when active turns exceed capacity", () => {
    const result = selectPromptWindow({ ...base, activeIndices: [1, 4, 7, 9, 12, 15] });
    expect(result.overCapacity).toBe(true);
    expect(result.indices).toEqual([1, 4, 7, 9, 12, 15]);
  });

  test("marks separated active turns over-capacity even when their count fits", () => {
    const result = selectPromptWindow({ ...base, activeIndices: [0, 10] });
    expect(result.overCapacity).toBe(true);
    expect(result.indices).toEqual([0, 10]);
  });
});

describe("projectPromptTicks", () => {
  test("is monotonic and respects minimum pitch when there is room", () => {
    const positions = projectPromptTicks([0, 10, 20], 100, 20);
    expect(positions).toEqual([0, 50, 100]);
    expect(positions[1]).toBeGreaterThan(positions[0]!);
    expect(positions[2]).toBeGreaterThan(positions[1]!);
  });

  test("handles empty, one, and compressed ranges", () => {
    expect(projectPromptTicks([], 100, 10)).toEqual([]);
    expect(projectPromptTicks([4], 100, 10)).toEqual([50]);
    expect(projectPromptTicks([0, 1, 2], 10, 20)).toEqual([0, 5, 10]);
  });
});

describe("projectPromptCluster", () => {
  test("returns no positions for no entries", () => {
    expect(projectPromptCluster([], 100, 14, 10)).toEqual([]);
  });

  test("centers a single marker in the rail", () => {
    expect(projectPromptCluster([0], 100, 14, 10)).toEqual([50]);
    expect(projectPromptCluster([42], 80, 14, 10)).toEqual([40]);
  });

  test("projects a normal multi-marker cluster into a compact centered span", () => {
    // usable = [10, 90]; desired span = 14 * 2 = 28; centered → [36, 50, 64].
    const positions = projectPromptCluster([0, 100, 200], 100, 14, 10);
    expect(positions).toEqual([36, 50, 64]);
    // The actual cluster span (28) is the compact bound and its center is the rail center.
    expect(positions[2]! - positions[0]!).toBe(14 * 2);
    expect((positions[0]! + positions[2]!) / 2).toBe(50);
  });

  test("enforces the minimum pitch for compressed offsets", () => {
    // Offsets 0, 5, 100 would project raw gaps of 1.4 and 26.6 — the sub-pitch gap is
    // replaced by evenly spaced centers at the minimum pitch before centering.
    const positions = projectPromptCluster([0, 5, 100], 100, 14, 10);
    expect(positions).toEqual([36, 50, 64]);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]! - positions[i - 1]!).toBeGreaterThanOrEqual(14);
    }
    expect((positions[0]! + positions[2]!) / 2).toBe(50);
  });

  test("stays bounded and nondecreasing on a degenerate tiny rail", () => {
    // Degenerate usable interval: inset == railHeight - inset.
    expect(projectPromptCluster([0], 20, 14, 10)).toEqual([10]);
    const multiple = projectPromptCluster([0, 100, 200], 20, 14, 10);
    expect(multiple).toEqual([10, 10, 10]);
    // Tiny-but-usable rail: 3 markers exceed the 2-slot capacity; every output stays
    // within [10, 30] and remains nondecreasing.
    const tiny = projectPromptCluster([0, 100, 200], 40, 14, 10);
    expect(tiny).toEqual([10, 20, 30]);
    for (const value of tiny) {
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(30);
    }
  });

  test("distributes over-capacity markers monotonically and bounded across the full rail", () => {
    // usable = [10, 90], capacity = floor(80 / 14) + 1 = 6; 8 markers overflow it.
    const positions = projectPromptCluster(
      [0, 10, 20, 30, 40, 50, 60, 70],
      100,
      14,
      10,
    );
    expect(positions).toHaveLength(8);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!).toBeGreaterThanOrEqual(positions[i - 1]!);
    }
    for (const value of positions) {
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(90);
    }
    // The intentional sub-pitch exception: boundedness wins, so some gaps drop below
    // the minimum pitch in the over-capacity fallback.
    const minGap = Math.min(
      ...positions.slice(1).map((value, i) => value - positions[i]!),
    );
    expect(minGap).toBeLessThan(14);
  });
});

describe("pairPromptTicks", () => {
  test("zips selected indices with positions without filling omitted indices", () => {
    expect(pairPromptTicks([0, 3, 7], [10, 40, 90])).toEqual([
      { index: 0, position: 10 },
      { index: 3, position: 40 },
      { index: 7, position: 90 },
    ]);
    expect(pairPromptTicks([], [])).toEqual([]);
  });

  test("rejects unequal-length inputs", () => {
    expect(() => pairPromptTicks([0, 1], [5])).toThrow(/equal-length/);
  });
});
