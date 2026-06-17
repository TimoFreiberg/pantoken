import { describe, expect, test } from "bun:test";
import { planWorktree } from "./worktree.js";

describe("planWorktree", () => {
  test("jj: workspace add at a sibling path with a unique name", () => {
    const p = planWorktree("/Users/x/repo", "jj", "abc");
    expect(p.path).toBe("/Users/x/repo-pilot-abc");
    expect(p.command).toBe("jj");
    expect(p.args).toEqual([
      "-R",
      "/Users/x/repo",
      "workspace",
      "add",
      "--name",
      "pilot-abc",
      "/Users/x/repo-pilot-abc",
    ]);
  });

  test("git: detached worktree at a sibling path", () => {
    // A trailing slash is normalized away before building the sibling path.
    const p = planWorktree("/Users/x/repo/", "git", "xy");
    expect(p.path).toBe("/Users/x/repo-pilot-xy");
    expect(p.command).toBe("git");
    expect(p.args).toEqual([
      "-C",
      "/Users/x/repo",
      "worktree",
      "add",
      "--detach",
      "/Users/x/repo-pilot-xy",
    ]);
  });
});
