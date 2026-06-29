// The basenames (without `.ts`) of every pilot-OWNED extension — the ones pilot
// shipped in-repo under a former in-process agent driver. This is the SINGLE source
// of truth for the owned set so the sites that need it can never disagree:
//   - the mock driver (simulates these extensions for dev/e2e);
//   - the client (the Settings UI flags pilot-owned rows + routes their toggles).
//
// NOTE (post-spike): under the polytoken daemon these names are historical — the
// daemon auto-names natively and the answer/tasklist extensions are built-in. The
// list is retained because the mock driver + hub still reference it; it's a plain
// readonly array, no runtime/DOM deps. Kept in `protocol/` (not `server/`) so the
// client imports it without pulling server code.
export const PILOT_OWNED_EXTENSION_NAMES: readonly string[] = [
  "session-namer",
  "tasklist",
  "answer",
];

/** Is `nameOrBasename` a pilot-OWNED extension? Accepts the basename with or without a
 *  trailing `.ts` (the Settings list / fixture rows carry `name.ts`; the protocol list
 *  stores the bare basename). The shared predicate so the client + server can't disagree
 *  on what counts as owned — collapse any `name.replace(/\.ts$/, "") + includes` into this. */
export function isPilotOwnedExtension(nameOrBasename: string): boolean {
  return PILOT_OWNED_EXTENSION_NAMES.includes(nameOrBasename.replace(/\.ts$/, ""));
}
