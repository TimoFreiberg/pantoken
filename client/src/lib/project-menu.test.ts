import { describe, expect, test } from "bun:test";
import type { SessionListEntry } from "@pantoken/protocol";
import { deriveKnownProjects, rankProjects } from "./project-menu.js";

const NOW = 1_700_000_000_000;
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

function entry(over: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    sessionId: "s",
    path: "/s.jsonl",
    cwd: "/proj",
    preview: "",
    userMessageCount: 1,
    updatedAt: isoAgo(0),
    createdAt: isoAgo(0),
    lastUserMessageAt: isoAgo(0),
    archived: false,
    ...over,
  };
}

describe("deriveKnownProjects", () => {
  test("deduplicates by project cwd", () => {
    const sessions = [
      entry({ sessionId: "a", cwd: "/proj/pantoken" }),
      entry({ sessionId: "b", cwd: "/proj/pantoken" }),
      entry({ sessionId: "c", cwd: "/proj/scratch" }),
    ];
    const projects = deriveKnownProjects(sessions);
    expect(projects).toHaveLength(2);
    const cwds = projects.map((p) => p.cwd).sort();
    expect(cwds).toEqual(["/proj/pantoken", "/proj/scratch"]);
  });

  test("groups worktree sessions under their base", () => {
    const sessions = [
      entry({
        sessionId: "wt",
        cwd: "/proj/pantoken-wt",
        worktree: { path: "/proj/pantoken-wt", base: "/proj/pantoken", name: "pantoken-wt" },
      }),
      entry({ sessionId: "main", cwd: "/proj/pantoken" }),
    ];
    const projects = deriveKnownProjects(sessions);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.cwd).toBe("/proj/pantoken");
    expect(projects[0]!.name).toBe("pantoken");
  });

  test("sorts by most-recently-used first", () => {
    const sessions = [
      entry({ sessionId: "old", cwd: "/proj/old", lastUserMessageAt: isoAgo(60_000 * 60) }),
      entry({ sessionId: "new", cwd: "/proj/new", lastUserMessageAt: isoAgo(60_000) }),
      entry({ sessionId: "mid", cwd: "/proj/mid", lastUserMessageAt: isoAgo(60_000 * 30) }),
    ];
    const projects = deriveKnownProjects(sessions);
    expect(projects.map((p) => p.cwd)).toEqual([
      "/proj/new",
      "/proj/mid",
      "/proj/old",
    ]);
  });

  test("keeps the most recent lastUsed when deduplicating", () => {
    const sessions = [
      entry({ sessionId: "a", cwd: "/proj/pantoken", lastUserMessageAt: isoAgo(60_000 * 10) }),
      entry({ sessionId: "b", cwd: "/proj/pantoken", lastUserMessageAt: isoAgo(60_000) }),
    ];
    const projects = deriveKnownProjects(sessions);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.lastUsed).toBe(isoAgo(60_000));
  });

  test("falls back to updatedAt when lastUserMessageAt is absent", () => {
    const sessions = [
      entry({ sessionId: "a", cwd: "/proj/a", lastUserMessageAt: undefined, updatedAt: isoAgo(60_000) }),
      entry({ sessionId: "b", cwd: "/proj/b", lastUserMessageAt: undefined, updatedAt: isoAgo(60_000 * 10) }),
    ];
    const projects = deriveKnownProjects(sessions);
    expect(projects.map((p) => p.cwd)).toEqual(["/proj/a", "/proj/b"]);
  });

  test("name is the basename of cwd", () => {
    const projects = deriveKnownProjects([
      entry({ cwd: "/Users/timo/src/pantoken" }),
    ]);
    expect(projects[0]!.name).toBe("pantoken");
  });

  test("handles trailing slashes in cwd for name derivation", () => {
    const projects = deriveKnownProjects([
      entry({ cwd: "/Users/timo/src/scratch/" }),
    ]);
    expect(projects[0]!.name).toBe("scratch");
  });
});

describe("rankProjects", () => {
  const projects = [
    { cwd: "/proj/pantoken", name: "pantoken", lastUsed: "3" },
    { cwd: "/proj/scratch", name: "scratch", lastUsed: "2" },
    { cwd: "/proj/retry-lib", name: "retry-lib", lastUsed: "1" },
  ];

  test("empty query returns all projects in MRU order", () => {
    const result = rankProjects(projects, "");
    expect(result.map((p) => p.cwd)).toEqual([
      "/proj/pantoken",
      "/proj/scratch",
      "/proj/retry-lib",
    ]);
  });

  test("prefix matches rank first", () => {
    const projects = [
      { cwd: "/proj/retro", name: "retro", lastUsed: "3" },
      { cwd: "/proj/retry-lib", name: "retry-lib", lastUsed: "2" },
    ];
    const result = rankProjects(projects, "re");
    // Both are prefix matches, MRU order preserved.
    expect(result.map((p) => p.name)).toEqual(["retro", "retry-lib"]);
  });

  test("prefix match ranks before fuzzy-only match", () => {
    const projects = [
      { cwd: "/proj/abc", name: "abc", lastUsed: "3" },
      { cwd: "/proj/xaxc", name: "xaxc", lastUsed: "2" },
    ];
    const result = rankProjects(projects, "ac");
    // "xaxc" is a fuzzy (subsequence) match, "abc" is a prefix match.
    expect(result.map((p) => p.name)).toEqual(["abc", "xaxc"]);
  });

  test("fuzzy subsequence match works case-insensitively", () => {
    const result = rankProjects(projects, "PAN");
    expect(result.map((p) => p.name)).toEqual(["pantoken"]);
  });

  test("non-matching query returns empty", () => {
    const result = rankProjects(projects, "zzz");
    expect(result).toHaveLength(0);
  });

  test("MRU order preserved for ties (all fuzzy-only matches)", () => {
    const projects = [
      { cwd: "/proj/alpha", name: "alpha", lastUsed: "3" },
      { cwd: "/proj/beta", name: "beta", lastUsed: "2" },
      { cwd: "/proj/gamma", name: "gamma", lastUsed: "1" },
    ];
    const result = rankProjects(projects, "a");
    // "a" is a prefix of "alpha" only. It's a fuzzy (subsequence) match for
    // "beta" and "gamma" too. Prefix first, then fuzzy-only in MRU order.
    expect(result.map((p) => p.name)).toEqual(["alpha", "beta", "gamma"]);
  });
});
