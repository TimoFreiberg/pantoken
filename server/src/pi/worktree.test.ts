import { describe, expect, test } from "bun:test";
import {
  planWorktree,
  planWorktreeRemoval,
  type WorktreeMeta,
} from "./worktree.js";

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

  test("create plan exposes name + base for the worktree index", () => {
    const p = planWorktree("/Users/x/repo", "jj", "abc");
    expect(p.name).toBe("pilot-abc");
    expect(p.base).toBe("/Users/x/repo");
  });
});

describe("planWorktreeRemoval", () => {
  const jjMeta: WorktreeMeta = {
    path: "/Users/x/repo-pilot-abc",
    base: "/Users/x/repo",
    vcs: "jj",
    name: "pilot-abc",
  };
  const gitMeta: WorktreeMeta = {
    path: "/Users/x/repo-pilot-xy",
    base: "/Users/x/repo",
    vcs: "git",
    name: "pilot-xy",
  };

  test("jj: forget the workspace by name, then the caller removes the dir", () => {
    const p = planWorktreeRemoval(jjMeta, false);
    expect(p.command).toBe("jj");
    expect(p.args).toEqual([
      "-R",
      "/Users/x/repo",
      "workspace",
      "forget",
      "pilot-abc",
    ]);
    // jj leaves the dir behind, so the caller must rm it.
    expect(p.removeDir).toBe(true);
  });

  test("git: worktree remove deletes the dir itself (no separate rm)", () => {
    const p = planWorktreeRemoval(gitMeta, false);
    expect(p.command).toBe("git");
    expect(p.args).toEqual([
      "-C",
      "/Users/x/repo",
      "worktree",
      "remove",
      "/Users/x/repo-pilot-xy",
    ]);
    expect(p.removeDir).toBe(false);
  });

  test("git: force adds --force to discard a dirty worktree", () => {
    const p = planWorktreeRemoval(gitMeta, true);
    expect(p.args).toContain("--force");
  });
});
