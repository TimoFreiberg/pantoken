// The worktree index: pilot's record of the jj/git worktrees IT created (via the
// new-session worktree toggle), keyed by the worktree dir — which is the session's cwd.
// Mirrors ArchiveStore: a small persisted map so listSessions can flag worktree-backed
// sessions with an in-memory lookup, and so cleanup only ever touches worktrees pilot
// made (never a worktree the user manages by hand).
//
// This is STATE, not a cache: it's never rebuilt by scanning the disk, so deleting the
// backing file just makes pilot forget it owns those worktrees (a recoverable loss for a
// single-user tool). It lives under config.dataDir next to the archive index.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import type { WorktreeMeta } from "./pi/worktree.js";

export function defaultWorktreeFile(): string {
  return join(config.dataDir, "worktrees.json");
}

export class WorktreeStore {
  private byPath = new Map<string, WorktreeMeta>();

  constructor(private readonly file: string = defaultWorktreeFile()) {
    mkdirSync(dirname(file), { recursive: true });
    this.load();
  }

  /** The worktree pilot created at this path (== a session cwd), or undefined. */
  get(path: string): WorktreeMeta | undefined {
    return this.byPath.get(path);
  }

  add(meta: WorktreeMeta): void {
    this.byPath.set(meta.path, meta);
    this.persist();
  }

  remove(path: string): void {
    if (this.byPath.delete(path)) this.persist();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const arr = JSON.parse(readFileSync(this.file, "utf8")) as WorktreeMeta[];
      for (const m of arr) this.byPath.set(m.path, m);
      if (arr.length)
        console.log(`[worktree] loaded ${arr.length} tracked worktree(s)`);
    } catch (e) {
      console.error("[worktree] failed to load index", e);
    }
  }

  private persist(): void {
    writeFileSync(
      this.file,
      JSON.stringify([...this.byPath.values()], null, 2),
    );
  }
}
