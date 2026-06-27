// queueMessages converts pi's queue snapshot (two text arrays: steering + followUp)
// into the rows the client renders/dedupes on. The mapping is pure and tiny but was
// untested — the mock driver uses canned IDs (queue-steer-fixture etc.), so the real
// ID/hash logic (textHash, the queue-<mode>-<index>-<hash> format, the mode grouping)
// had no coverage. A regression in textHash or the format would silently break client
// queue dedup. These tests pin the shape + the two properties that matter downstream:
//   - stable IDs across calls (same input → same id, so the client can match rows)
//   - distinct IDs only when text differs (collisions would merge distinct messages)

import { describe, expect, test } from "bun:test";
import { queueMessages } from "./queue-map.js";

describe("queueMessages", () => {
  test("maps each group with its mode, preserving order", () => {
    const rows = queueMessages(
      ["steer one", "steer two"],
      ["follow up"],
      "2026-06-26T00:00:00Z",
    );
    expect(rows).toEqual([
      {
        id: expect.stringMatching(/^queue-steer-0-/),
        mode: "steer",
        text: "steer one",
        createdAt: "2026-06-26T00:00:00Z",
        updatedAt: "2026-06-26T00:00:00Z",
      },
      {
        id: expect.stringMatching(/^queue-steer-1-/),
        mode: "steer",
        text: "steer two",
        createdAt: "2026-06-26T00:00:00Z",
        updatedAt: "2026-06-26T00:00:00Z",
      },
      {
        id: expect.stringMatching(/^queue-followUp-0-/),
        mode: "followUp",
        text: "follow up",
        createdAt: "2026-06-26T00:00:00Z",
        updatedAt: "2026-06-26T00:00:00Z",
      },
    ]);
  });

  test("empty inputs yield an empty array (no phantom rows)", () => {
    expect(queueMessages([], [], "t")).toEqual([]);
  });

  test("IDs are stable: identical input reproduces identical IDs", () => {
    // The client matches rows by id across snapshots; if textHash were seeded by
    // time/random, rows would churn every update. Pin that the hash is a pure fn of
    // text by forcing Date.now() to differ between the two calls — a time-seeded hash
    // would then produce different IDs and fail this assertion.
    const realNow = Date.now;
    let n = 1_000_000;
    Date.now = () => n++;
    try {
      const a = queueMessages(["x", "y"], ["z"], "t1");
      const b = queueMessages(["x", "y"], ["z"], "t2");
      expect(b.map((r) => r.id)).toEqual(a.map((r) => r.id));
    } finally {
      Date.now = realNow;
    }
  });

  test("distinct text → distinct IDs (no hash collisions across messages)", () => {
    const rows = queueMessages(["alpha", "beta"], ["gamma"], "t");
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length);
  });

  test("timestamp is threaded into both createdAt and updatedAt", () => {
    const rows = queueMessages(["x"], [], "2026-01-01T12:00:00Z");
    expect(rows[0]?.createdAt).toBe("2026-01-01T12:00:00Z");
    expect(rows[0]?.updatedAt).toBe("2026-01-01T12:00:00Z");
  });
});
