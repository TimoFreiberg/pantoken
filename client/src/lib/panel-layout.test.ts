import { describe, expect, test } from "bun:test";
import {
  canShowAutoRightSidebar,
  parseRightSidebarPreference,
} from "./panel-layout.js";

describe("right sidebar preference migration", () => {
  test("uses the new preference when valid", () => {
    expect(parseRightSidebarPreference("auto", "0")).toBe("auto");
    expect(parseRightSidebarPreference("closed", "1")).toBe("closed");
  });

  test("maps legacy false to closed and true or absent to auto", () => {
    expect(parseRightSidebarPreference(null, "0")).toBe("closed");
    expect(parseRightSidebarPreference(null, "1")).toBe("auto");
    expect(parseRightSidebarPreference(null, null)).toBe("auto");
  });
});

describe("automatic context panel fit", () => {
  test("accounts for the actual open panel widths and transcript floor", () => {
    expect(canShowAutoRightSidebar(1087, true, 288, 280)).toBe(false);
    expect(canShowAutoRightSidebar(1088, true, 288, 280)).toBe(true);
    expect(canShowAutoRightSidebar(800, false, 288, 280)).toBe(true);
  });

  test("respects resized panel widths", () => {
    expect(canShowAutoRightSidebar(1200, true, 500, 300)).toBe(false);
    expect(canShowAutoRightSidebar(1320, true, 500, 300)).toBe(true);
  });
});
