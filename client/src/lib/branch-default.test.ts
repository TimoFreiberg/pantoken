import { test, expect } from "bun:test";
import { pickDefaultBranch } from "./branch-default.js";

test("returns main when main is present", () => {
  expect(pickDefaultBranch(["develop", "main", "feature"])).toBe("main");
});

test("returns master when master is present but not main", () => {
  expect(pickDefaultBranch(["develop", "master", "feature"])).toBe("master");
});

test("returns first branch when neither main nor master", () => {
  expect(pickDefaultBranch(["develop", "feature", "release"])).toBe("develop");
});

test("returns undefined for empty list", () => {
  expect(pickDefaultBranch([])).toBeUndefined();
});

test("returns main even when it's the only branch", () => {
  expect(pickDefaultBranch(["main"])).toBe("main");
});

test("prefers main over master when both present", () => {
  expect(pickDefaultBranch(["master", "main"])).toBe("main");
});
