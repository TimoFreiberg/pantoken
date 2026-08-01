import { describe, expect, test } from "vitest";
import { toolPreview, webSearchResultTitle } from "./tool-preview.js";

// The toolPreview dispatch group was cut (297 lines mirroring a 215-line switch
// dispatch). Two non-trivial transformations were kept (AC.6):

describe("toolPreview: block_goal struct terminal_reason", () => {
  test("block_goal with struct terminal_reason prefers detail", () => {
    expect(
      toolPreview(
        "block_goal",
        {
          terminal_reason: { kind: "blocked", detail: "No credentials found" },
        },
        undefined,
      ),
    ).toBe("No credentials found");
  });

  test("block_goal with struct terminal_reason falls back to kind", () => {
    expect(
      toolPreview(
        "block_goal",
        { terminal_reason: { kind: "blocked" } },
        undefined,
      ),
    ).toBe("blocked");
  });

  test("block_goal with struct terminal_reason and missing detail falls back to kind", () => {
    expect(
      toolPreview(
        "block_goal",
        { terminal_reason: { kind: "complete" } },
        undefined,
      ),
    ).toBe("complete");
  });
});

// ── webSearchResultTitle: output shape parsing ───────────────────────────────

describe("toolPreview: grep and glob arguments", () => {
  test("grep shows both path and pattern", () => {
    expect(
      toolPreview(
        "grep",
        { path: "client/src", pattern: "ToolCard" },
        undefined,
      ),
    ).toBe("client/src ToolCard");
  });

  test("glob shows both path and pattern", () => {
    expect(
      toolPreview(
        "glob",
        { path: "server", pattern: "**/*.rs" },
        undefined,
      ),
    ).toBe("server **/*.rs");
  });
});

describe("webSearchResultTitle", () => {
  test("plain string with JSON array returns first title + ellipsis", () => {
    const output = JSON.stringify([
      { title: "First", url: "https://a.com" },
      { title: "Second", url: "https://b.com" },
    ]);
    expect(webSearchResultTitle(output)).toBe("First, …");
  });

  test("plain string with single result returns title without ellipsis", () => {
    const output = JSON.stringify([{ title: "Only", url: "https://a.com" }]);
    expect(webSearchResultTitle(output)).toBe("Only");
  });

  test("raw array returns first title + ellipsis", () => {
    expect(
      webSearchResultTitle([
        { title: "First", url: "https://a.com" },
        { title: "Second", url: "https://b.com" },
      ]),
    ).toBe("First, …");
  });

  test("content-wrapped object returns first title + ellipsis", () => {
    const output = {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { title: "First", url: "https://a.com" },
            { title: "Second", url: "https://b.com" },
          ]),
        },
      ],
    };
    expect(webSearchResultTitle(output)).toBe("First, …");
  });

  test("malformed string returns null", () => {
    expect(webSearchResultTitle("not json")).toBeNull();
  });

  test("empty array string returns null", () => {
    expect(webSearchResultTitle("[]")).toBeNull();
  });

  test("non-array JSON string returns null", () => {
    expect(webSearchResultTitle('{"foo":"bar"}')).toBeNull();
  });

  test("null returns null", () => {
    expect(webSearchResultTitle(null)).toBeNull();
  });

  test("undefined returns null", () => {
    expect(webSearchResultTitle(undefined)).toBeNull();
  });

  test("number returns null", () => {
    expect(webSearchResultTitle(42)).toBeNull();
  });

  test("array with non-object first element returns null", () => {
    expect(webSearchResultTitle(["string", { title: "Second" }])).toBeNull();
  });

  test("array element without title returns null", () => {
    expect(webSearchResultTitle([{ url: "https://a.com" }])).toBeNull();
  });
});
