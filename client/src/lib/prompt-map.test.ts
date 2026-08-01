import { describe, expect, test } from "vitest";
import {
  calculatePromptIntervals,
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
