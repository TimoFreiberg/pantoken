/** The header subtitle's "where am I" line under the session title: the project
 *  name (basename of the session cwd), with an optional deviation suffix when
 *  the live working directory differs from the project root (e.g. after pushd).
 *  Pure + DOM-free so it's unit-testable; the component feeds it the active
 *  session's list entry (the stable project root) and the folded snapshot's
 *  live cwd. */
export function sessionSubtitle(opts: {
  cwd?: string;
  liveCwd?: string;
  /** Home directory used to abbreviate out-of-project paths; defaults to HOME. */
  home?: string;
}): string {
  const projectCwd = opts.cwd ?? "";
  if (!projectCwd) return "no session";
  const projectBasename = basename(projectCwd);
  const liveCwd = opts.liveCwd;
  if (!liveCwd || liveCwd === projectCwd) {
    return projectBasename;
  }
  // Deviation: show the relative path from the project root.
  if (liveCwd.startsWith(projectCwd + "/")) {
    const rel = liveCwd.slice(projectCwd.length + 1);
    return `${projectBasename} › ${rel}`;
  }
  // Outside the project: show the full path with ~ for home.
  return `${projectBasename} › ${tildeHome(liveCwd, opts.home)}`;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** Replace a leading $HOME with ~ for compact display of out-of-project paths. */
function tildeHome(p: string, homeOverride?: string): string {
  const home =
    homeOverride ??
    (typeof process !== "undefined" && process.env?.HOME
      ? process.env.HOME
      : "");
  if (home && p.startsWith(home + "/")) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}
