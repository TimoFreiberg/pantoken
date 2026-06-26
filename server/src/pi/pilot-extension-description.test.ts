// T1: the production `pilotExtensionDescription` parser had NO direct test — the e2e
// asserts a hardcoded mock fixture's description, and the Chunk 2 unit test
// (session-namer-extension.test.ts (d)) RE-IMPLEMENTED the frontmatter regex inline
// instead of calling the function. This locks the real parser: it imports
// `pilotExtensionDescription` from pi-driver and drives it against the real
// session-namer.ts source (a well-formed `@pilot` block) plus crafted inputs (a file
// with no `@pilot` block; a block without a `description:` line) — the three shapes the
// Settings list can encounter. `pilotExtensionDescription` is a pure file-reading fn
// (caches per path), so crafted inputs are written to temp files.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { pilotExtensionDescription } from "./pi-driver.js";

// The real pilot-owned extension source — same repo-root-absolute resolution
// pi-driver.ts builds its PILOT_OWNED_EXTENSIONS map with.
const NAMER_PATH = resolve(
  import.meta.dir,
  "../../../pilot/extensions/session-namer.ts",
);

describe("pilotExtensionDescription — the production frontmatter parser", () => {
  test("parses the real session-namer.ts @pilot description", () => {
    // The contract: a leading `/** @pilot … description: <value> */` block. Asserts the
    // parser (regex + the `@pilot` guard + the `description:` line strip) finds the line
    // the source actually ships — a regression guard if either the frontmatter shape or
    // the parser drifts.
    expect(pilotExtensionDescription(NAMER_PATH)).toBe(
      "Auto-names a session from its first prompt via the background model.",
    );
  });

  test("returns undefined when there is no @pilot frontmatter block", () => {
    // A plain extension (user/project) with no `@pilot` marker stays description-less —
    // the parser must NOT misread a random leading comment as a description. (The marker
    // check is a substring `includes("@pilot")`, so the prose here carefully avoids that
    // literal — a doc comment that merely mentions the word would still match.)
    const dir = mkdtempSync(join(tmpdir(), "pilot-desc-noop-"));
    const p = join(dir, "plain.ts");
    writeFileSync(
      p,
      [
        "/** A normal doc comment without the pilot marker.",
        " * description: this must NOT be picked up.",
        " */",
        "export default function () {}",
      ].join("\n"),
    );
    expect(pilotExtensionDescription(p)).toBeUndefined();
  });

  test("returns undefined when the @pilot block has no description: line", () => {
    // A `@pilot` block that omits `description:` (malformed/incomplete) yields no
    // description rather than crashing or returning an empty string.
    const dir = mkdtempSync(join(tmpdir(), "pilot-desc-nodesc-"));
    const p = join(dir, "nodesc.ts");
    writeFileSync(
      p,
      [
        "/** @pilot",
        " * name: Some extension",
        " */",
        "export default function () {}",
      ].join("\n"),
    );
    expect(pilotExtensionDescription(p)).toBeUndefined();
  });

  test("parses a crafted well-formed @pilot block end-to-end", () => {
    // Locks the full path: marker guard → description line strip → trim, on a crafted
    // block (so it isn't coupled to what session-namer.ts happens to ship today).
    const dir = mkdtempSync(join(tmpdir(), "pilot-desc-crafted-"));
    const p = join(dir, "crafted.ts");
    writeFileSync(
      p,
      [
        "/** @pilot",
        " * name: Crafted",
        " * description:   A crafted description with leading spaces.  ",
        " */",
        "export default function () {}",
      ].join("\n"),
    );
    expect(pilotExtensionDescription(p)).toBe(
      "A crafted description with leading spaces.",
    );
  });
});
