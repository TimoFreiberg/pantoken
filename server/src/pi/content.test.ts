import { describe, expect, test } from "bun:test";
import {
  imagesFromContent,
  splitToolResult,
  textFromContent,
} from "./content.js";

describe("imagesFromContent", () => {
  test("extracts image blocks as typed ImageContent", () => {
    expect(
      imagesFromContent([
        { type: "text", text: "hi" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ]),
    ).toEqual([{ type: "image", data: "QUJD", mimeType: "image/png" }]);
  });

  test("undefined when there are no images, for a string, or a trimmed image block", () => {
    expect(imagesFromContent([{ type: "text", text: "hi" }])).toBeUndefined();
    expect(imagesFromContent("just a string")).toBeUndefined();
    // A block missing data/mimeType isn't a usable image.
    expect(imagesFromContent([{ type: "image" }])).toBeUndefined();
  });
});

describe("textFromContent", () => {
  test("joins text blocks, drops images (no [image] placeholder)", () => {
    expect(
      textFromContent([
        { type: "text", text: "a" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  test("passes a plain string through; empty for null/non-array", () => {
    expect(textFromContent("hello")).toBe("hello");
    expect(textFromContent(null)).toBe("");
    expect(textFromContent(42)).toBe("");
  });
});

describe("splitToolResult", () => {
  test("strips image blocks from output, keeps text + details, lifts images", () => {
    expect(
      splitToolResult({
        content: [
          { type: "text", text: "Rendered." },
          { type: "image", data: "QUJD", mimeType: "image/png" },
        ],
        details: { ok: true },
      }),
    ).toEqual({
      output: {
        content: [{ type: "text", text: "Rendered." }],
        details: { ok: true },
      },
      images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    });
  });

  test("passes through results with no images, and non-object results", () => {
    const noImg = { content: [{ type: "text", text: "ok" }] };
    expect(splitToolResult(noImg)).toEqual({ output: noImg });
    expect(splitToolResult("plain string")).toEqual({ output: "plain string" });
    expect(splitToolResult(null)).toEqual({ output: null });
  });

  test("an image-only result leaves output with empty content + the image lifted out", () => {
    expect(
      splitToolResult({
        content: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
      }),
    ).toEqual({
      output: { content: [] },
      images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    });
  });
});
