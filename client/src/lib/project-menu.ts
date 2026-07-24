// Pure logic for the ProjectMenu component: derive the set of known project
// directories from the session list, and fuzzy-rank them by a search query.
// DOM-free + unit-testable, mirroring the pattern of directory-picker.ts and
// model-picker-helpers.ts.

import type { SessionListEntry } from "@pantoken/protocol";
import {
  lastInteractionKey,
  projectCwdOf,
  projectName,
} from "./session-filter.js";

export interface KnownProject {
  /** The project directory (worktree sessions group under their base via projectCwdOf). */
  cwd: string;
  /** Basename of cwd (mirrors session-filter.ts projectName). */
  name: string;
  /** Most recent lastUserMessageAt || updatedAt among sessions in this project —
   *  the MRU sort key (ISO string, lexicographically comparable). */
  lastUsed: string;
}

/** Derive the set of known projects from the session list, deduplicated by
 *  project cwd (using projectCwdOf — worktree sessions group under their base).
 *  Sorted by most-recently-used first (newest interaction on top). */
export function deriveKnownProjects(
  sessions: readonly SessionListEntry[],
): KnownProject[] {
  const byCwd = new Map<string, KnownProject>();
  for (const s of sessions) {
    const cwd = projectCwdOf(s);
    const key = lastInteractionKey(s);
    const existing = byCwd.get(cwd);
    if (!existing || key > existing.lastUsed) {
      byCwd.set(cwd, {
        cwd,
        name: projectName(cwd),
        lastUsed: key,
      });
    }
  }
  return [...byCwd.values()].sort((a, b) =>
    b.lastUsed.localeCompare(a.lastUsed),
  );
}

/** Whether `query` is a subsequence of `target` (fuzzy match, case-insensitive).
 *  Copied from directory-picker.ts / model-picker-helpers.ts. */
function fuzzyMatch(query: string, target: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

/** Fuzzy-rank projects by query (subsequence match, case-insensitive).
 *  Prefix matches rank first, then fuzzy matches, preserving MRU order for ties.
 *  Empty query returns all projects unranked (in MRU order). */
export function rankProjects(
  projects: readonly KnownProject[],
  query: string,
): KnownProject[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...projects];
  return projects
    .map((project, order) => {
      const name = project.name.toLowerCase();
      const prefix = name.startsWith(q);
      const fuzzy = fuzzyMatch(q, name);
      return { project, prefix, fuzzy, order };
    })
    .filter((entry) => entry.fuzzy)
    .sort(
      (a, b) => Number(b.prefix) - Number(a.prefix) || a.order - b.order,
    )
    .map((entry) => entry.project);
}
