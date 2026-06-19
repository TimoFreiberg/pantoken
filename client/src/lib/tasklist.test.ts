import { describe, expect, test } from "bun:test";
import { parseTasklist } from "./tasklist.js";

describe("parseTasklist", () => {
  test("parses the extension's real format (header + ○ items)", () => {
    const lines = [
      "Open Tasks (3):",
      "  ○ #v23gry: first item",
      "  ○ #4dhaiz: item numero dos",
      "  ○ #dyouxr: and a third, why not",
    ];
    expect(parseTasklist(lines)).toEqual([
      { id: "v23gry", description: "first item" },
      { id: "4dhaiz", description: "item numero dos" },
      { id: "dyouxr", description: "and a third, why not" },
    ]);
  });

  test("ignores the header line, keeps only items", () => {
    const parsed = parseTasklist(["Open Tasks (1):", "  ○ #abc: solo"]);
    expect(parsed).toEqual([{ id: "abc", description: "solo" }]);
  });

  test("keeps colons inside the description", () => {
    const parsed = parseTasklist(["  ○ #x1: fix foo: the bar case"]);
    expect(parsed).toEqual([
      { id: "x1", description: "fix foo: the bar case" },
    ]);
  });

  test("returns null when nothing parses (empty or unrecognized)", () => {
    expect(parseTasklist([])).toBeNull();
    expect(parseTasklist(undefined)).toBeNull();
    expect(parseTasklist(["Open Tasks (0):"])).toBeNull();
    expect(
      parseTasklist(["some unrelated widget", "no items here"]),
    ).toBeNull();
  });
});
