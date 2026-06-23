import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countUserMessages, userMessageStats } from "./user-message-count.js";

const header = JSON.stringify({ type: "session", id: "s", timestamp: "t" });
const msg = (role: string, text: string) =>
  JSON.stringify({ type: "message", message: { role, content: text } });
// A message line carrying the entry-level ISO timestamp pi writes on every append.
const msgAt = (role: string, text: string, timestamp: string) =>
  JSON.stringify({
    type: "message",
    timestamp,
    message: { role, content: text },
  });

async function writeSession(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pilot-umc-"));
  const path = join(dir, "session.jsonl");
  await writeFile(path, lines.join("\n"));
  return path;
}

describe("countUserMessages", () => {
  test("counts only role-user messages, ignoring assistant/toolResult/non-message", () => {
    return (async () => {
      const path = await writeSession([
        header,
        msg("user", "first prompt"),
        msg("assistant", "a reply"),
        msg("toolResult", "tool output"),
        msg("user", "second prompt"),
        JSON.stringify({ type: "model_change", model: "x" }),
        msg("assistant", "another reply"),
      ]);
      // 7 total entries, 2 of them the operator's.
      expect(await countUserMessages(path, 1, 7)).toBe(2);
    })();
  });

  test("lastUserAtMs is the timestamp of the LAST role-user entry, ignoring assistant turns", async () => {
    const path = await writeSession([
      header,
      msgAt("user", "first", "2026-06-20T10:00:00.000Z"),
      msgAt("assistant", "reply", "2026-06-20T10:05:00.000Z"), // later, but not a user turn
      msgAt("user", "second", "2026-06-20T10:02:00.000Z"),
    ]);
    const stats = await userMessageStats(path, 1, 4);
    expect(stats.count).toBe(2);
    // The second user message (10:02), NOT the assistant's later 10:05 activity.
    expect(stats.lastUserAtMs).toBe(Date.parse("2026-06-20T10:02:00.000Z"));
  });

  test("lastUserAtMs is undefined when there's no user message", async () => {
    const path = await writeSession([
      header,
      msgAt("assistant", "hello", "2026-06-20T10:00:00.000Z"),
    ]);
    const stats = await userMessageStats(path, 1, 2);
    expect(stats.count).toBe(0);
    expect(stats.lastUserAtMs).toBeUndefined();
  });

  test("prefers a numeric message.timestamp over the entry-level ISO string", async () => {
    const line = JSON.stringify({
      type: "message",
      timestamp: "2026-06-20T10:00:00.000Z",
      message: { role: "user", content: "x", timestamp: 1_750_000_000_000 },
    });
    const path = await writeSession([header, line]);
    const stats = await userMessageStats(path, 1, 2);
    expect(stats.lastUserAtMs).toBe(1_750_000_000_000);
  });

  test("a torn final line (mid-write) is skipped, not fatal", async () => {
    const path = await writeSession([
      header,
      msg("user", "only prompt"),
      '{"type":"message","message":{"role":"user", // truncated',
    ]);
    expect(await countUserMessages(path, 1, 3)).toBe(1);
  });

  test("caches by mtime+total: a changed file with the same key returns the stale count", async () => {
    const path = await writeSession([header, msg("user", "one")]);
    expect(await countUserMessages(path, 100, 2)).toBe(1);
    // Rewrite with a second user message but reuse the same cache key — proves the
    // cached value is served (no re-scan) when neither mtime nor total changed.
    await writeFile(
      path,
      [header, msg("user", "one"), msg("user", "two")].join("\n"),
    );
    expect(await countUserMessages(path, 100, 2)).toBe(1);
    // Bump the total (a new turn pi would have counted) → cache invalidates, re-scans.
    expect(await countUserMessages(path, 100, 3)).toBe(2);
  });
});
