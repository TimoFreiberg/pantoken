import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { expect, test } from "vitest";
import { foldAll } from "./state.js";
import type { SessionDriverEvent } from "./session-driver.js";

const corpusDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "server-rs", "pantoken-protocol", "tests", "fold-corpus",
);

for (const file of readdirSync(corpusDir).filter((f) => f.endsWith(".json"))) {
  const json = JSON.parse(readFileSync(join(corpusDir, file), "utf-8"));
  test(`fold corpus: ${json.name}`, () => {
    const state = foldAll(json.events as SessionDriverEvent[]);
    // Serialize → parse to normalize (strips undefined, matches JSON wire shape)
    const actual = JSON.parse(JSON.stringify(state));
    expect(actual).toEqual(json.expected);
  });
}
