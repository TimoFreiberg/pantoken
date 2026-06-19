import { describe, expect, it } from "bun:test";
import {
  correlateEntryIds,
  type TextEntry,
  type TextMsg,
} from "./branch-ids.js";

const u = (text: string): TextMsg => ({ role: "user", text });
const a = (text: string): TextMsg => ({ role: "assistant", text });
const e = (id: string, role: string, text: string): TextEntry => ({
  id,
  role,
  text,
});

describe("correlateEntryIds", () => {
  it("zips a clean (uncompacted) branch 1:1 by role+text", () => {
    const messages = [u("hello"), a("hi there"), u("again")];
    const entries = [
      e("e1", "user", "hello"),
      e("e2", "assistant", "hi there"),
      e("e3", "user", "again"),
    ];
    expect(correlateEntryIds(messages, entries)).toEqual(["e1", "e2", "e3"]);
  });

  it("aligns from the tail, leaving compacted-away front messages unmatched", () => {
    // The in-context list starts with a compaction summary (role "compactionSummary")
    // that has no message-entry; the real turns follow. Only the tail aligns.
    const messages = [
      { role: "compactionSummary", text: "earlier work summarized" },
      u("recent question"),
      a("recent answer"),
    ];
    const entries = [
      e("old1", "user", "long-gone prompt"),
      e("old2", "assistant", "long-gone reply"),
      e("e9", "user", "recent question"),
      e("e10", "assistant", "recent answer"),
    ];
    expect(correlateEntryIds(messages, entries)).toEqual([
      undefined,
      "e9",
      "e10",
    ]);
  });

  it("stops at the first divergence rather than guessing a wrong id", () => {
    const messages = [u("A"), a("DIVERGED"), u("C")];
    const entries = [
      e("e1", "user", "A"),
      e("e2", "assistant", "B"),
      e("e3", "user", "C"),
    ];
    // Tail matches C; then assistant text differs → stop. A is left unmatched even
    // though it would have matched, because we can't trust the alignment past a gap.
    expect(correlateEntryIds(messages, entries)).toEqual([
      undefined,
      undefined,
      "e3",
    ]);
  });

  it("ignores non-message entries when aligning", () => {
    const messages = [u("hi"), a("yo")];
    const entries = [e("e1", "user", "hi"), e("e2", "assistant", "yo")];
    expect(correlateEntryIds(messages, entries)).toEqual(["e1", "e2"]);
  });

  it("returns all-undefined for empty inputs", () => {
    expect(correlateEntryIds([], [])).toEqual([]);
    expect(correlateEntryIds([u("x")], [])).toEqual([undefined]);
  });
});
