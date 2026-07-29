// Cross-language canon parity — TS side.
//
// The Rust test `canon_matches_ts_golden` (server-rs/pantoken-server/tests/corpus.rs)
// compares Rust's `canonicalize_scenario` output to a committed, frozen
// TS-produced golden. That catches Rust drift, but it cannot see a TS-only edit
// to `canonicalizeValue` that diverges from Rust until the golden is regenerated.
// This test closes that gap from the TS side: it runs the ACTUAL TS transform
// over the shared non-canonical fixture and deep-compares to the committed
// golden, so a TS canon change fails loud unless the golden is regenerated (and
// regenerating the golden then trips the Rust test unless Rust matches too).
//
// Regenerate the golden after an intentional canon change (BOTH files together):
//   cp server-rs/tests/canon-parity/non-canonical.json \
//      server-rs/tests/canon-parity/ts-canonical.golden.json
//   just capture-daemon-corpus --recanon \
//      server-rs/tests/canon-parity/ts-canonical.golden.json

import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalizeScenario,
  captureTarget,
  validateCaptureVersion,
} from "./capture-daemon-corpus";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PARITY_DIR = join(
  SCRIPT_DIR,
  "..",
  "server-rs",
  "tests",
  "canon-parity",
);

test("capture refuses an existing version without explicit override", () => {
  expect(() => captureTarget("0.5.8", "streaming-turn", false)).toThrow(
    /refusing to overwrite existing capture/,
  );
  expect(captureTarget("future-test-version", "streaming-turn", false)).toMatch(
    /future-test-version\/streaming-turn\.json$/,
  );
});

test("capture version is one safe path component", () => {
  expect(validateCaptureVersion("0.5.8-rc.1+local")).toBe("0.5.8-rc.1+local");
  for (const version of ["", ".", "..", "../../outside", "a/b", "a\\b", "/tmp/x"]) {
    expect(() => validateCaptureVersion(version), version).toThrow(
      /invalid daemon version/,
    );
  }
});

test("TS canonicalizeScenario matches the committed TS golden", () => {
  const input = JSON.parse(
    readFileSync(join(PARITY_DIR, "non-canonical.json"), "utf8"),
  );
  const golden = JSON.parse(
    readFileSync(join(PARITY_DIR, "ts-canonical.golden.json"), "utf8"),
  );

  const { http, sse, manifest } = canonicalizeScenario(input.http, input.sse);

  expect(http).toEqual(golden.http);
  expect(sse).toEqual(golden.sse);
  expect(manifest).toEqual(golden.canonicalization.prompt_ids);
});
