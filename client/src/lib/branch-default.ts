/** Pick the default base branch from a list of local branches.
 *  Returns "main" if present, else "master", else the first branch,
 *  else undefined (no branches). */
export function pickDefaultBranch(
  branches: readonly string[],
): string | undefined {
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return branches[0];
}
