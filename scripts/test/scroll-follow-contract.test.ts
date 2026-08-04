import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const todo = read("docs/TODO.md");
const reducer = read("client/src/lib/scroll-follow.ts");
const transcript = read("client/src/components/Transcript.svelte");

const staleContractPhrases = [
  "from any direction",
  "any cause → re-pin",
  "gap >= 80` on the unpin",
  "gap >= 80` geometry guard",
  "has left the 80px bottom zone",
];

describe("scroll-follow issue #159 contract", () => {
  test("the completed issue is not still advertised in the backlog", () => {
    expect(todo).not.toMatch(/- \[ \].*#159/);
  });

  test("comments describe directional re-pin and immediate gated upward unpin", () => {
    for (const phrase of staleContractPhrases) {
      expect(`${reducer}\n${transcript}`, `stale phrase: ${phrase}`).not.toContain(phrase);
    }
    expect(reducer).toContain("top > prevTop && gap < 80");
    expect(reducer).toContain("userScrolling || pointerDownOnScroller");
    expect(reducer).toContain("top < prevTop");
    expect(transcript).toContain("lastScrollTop && gap < 80");
    expect(transcript).toContain("progScrollUntil");
  });
});
