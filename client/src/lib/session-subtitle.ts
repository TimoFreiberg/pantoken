/** The header subtitle's "where am I" line under the session title: the project
 *  name (basename of the session cwd). Pure + DOM-free so it's unit-testable;
 *  the component feeds it the active session's list entry (the folded snapshot
 *  doesn't carry cwd). */
export function sessionSubtitle(opts: { cwd?: string }): string {
  const cwd = opts.cwd ?? "";
  if (!cwd) return "no session";
  return basename(cwd);
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}
