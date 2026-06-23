import { describe, expect, it } from "bun:test";
import {
  caretOnFirstLine,
  caretOnLastLine,
  dedupeConsecutive,
  nextHistoryIndex,
} from "./prompt-history.js";

describe("nextHistoryIndex", () => {
  it("no-ops on empty history", () => {
    expect(nextHistoryIndex(0, null, "up")).toBeUndefined();
    expect(nextHistoryIndex(0, null, "down")).toBeUndefined();
  });

  it("Up enters at the newest entry, then walks toward older", () => {
    expect(nextHistoryIndex(3, null, "up")).toBe(2);
    expect(nextHistoryIndex(3, 2, "up")).toBe(1);
    expect(nextHistoryIndex(3, 1, "up")).toBe(0);
  });

  it("Up at the oldest entry is a no-op", () => {
    expect(nextHistoryIndex(3, 0, "up")).toBeUndefined();
  });

  it("Down walks toward newer, then back to the live draft", () => {
    expect(nextHistoryIndex(3, 0, "down")).toBe(1);
    expect(nextHistoryIndex(3, 1, "down")).toBe(2);
    // Past the newest -> null = restore the saved work-in-progress draft.
    expect(nextHistoryIndex(3, 2, "down")).toBeNull();
  });

  it("Down while not navigating is a no-op", () => {
    expect(nextHistoryIndex(3, null, "down")).toBeUndefined();
  });

  it("a single-entry history round-trips up then down", () => {
    expect(nextHistoryIndex(1, null, "up")).toBe(0);
    expect(nextHistoryIndex(1, 0, "up")).toBeUndefined();
    expect(nextHistoryIndex(1, 0, "down")).toBeNull();
  });
});

describe("caretOnFirstLine / caretOnLastLine", () => {
  it("an empty field is both first and last line", () => {
    expect(caretOnFirstLine("", 0)).toBe(true);
    expect(caretOnLastLine("", 0)).toBe(true);
  });

  it("a single line is both first and last regardless of caret", () => {
    expect(caretOnFirstLine("hello", 0)).toBe(true);
    expect(caretOnFirstLine("hello", 5)).toBe(true);
    expect(caretOnLastLine("hello", 0)).toBe(true);
    expect(caretOnLastLine("hello", 5)).toBe(true);
  });

  it("tracks first/last across a multi-line value", () => {
    const v = "ab\ncd\nef";
    // caret in the first line
    expect(caretOnFirstLine(v, 1)).toBe(true);
    expect(caretOnLastLine(v, 1)).toBe(false);
    // caret right before the first newline still counts as first line
    expect(caretOnFirstLine(v, 2)).toBe(true);
    // caret in the middle line
    expect(caretOnFirstLine(v, 4)).toBe(false);
    expect(caretOnLastLine(v, 4)).toBe(false);
    // caret in the last line
    expect(caretOnFirstLine(v, 7)).toBe(false);
    expect(caretOnLastLine(v, 7)).toBe(true);
    // caret at the very end
    expect(caretOnLastLine(v, v.length)).toBe(true);
  });
});

describe("dedupeConsecutive", () => {
  it("collapses only adjacent duplicates", () => {
    expect(dedupeConsecutive(["a", "a", "b", "b", "a"])).toEqual([
      "a",
      "b",
      "a",
    ]);
  });
  it("leaves a distinct list untouched", () => {
    expect(dedupeConsecutive(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
  it("handles the empty list", () => {
    expect(dedupeConsecutive([])).toEqual([]);
  });
});
