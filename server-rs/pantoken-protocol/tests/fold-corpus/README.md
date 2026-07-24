# Fold Conformance Corpus

A shared set of JSON fixture files that both the Rust `fold_all` and the TS
`foldAll` implementations consume, asserting they produce identical folded
`SessionState` output for the same event sequences.

## File format

Each `.json` file has this shape:

```json
{
  "name": "unique-case-name",
  "description": "What this case covers",
  "events": [ ... SessionDriverEvent wire JSON ... ],
  "expected": { ... folded SessionState as JSON ... }
}
```

- `events` — array of `SessionDriverEvent` in wire JSON (camelCase, `type`-tagged).
- `expected` — the `SessionState` serialized to JSON after folding. Generated
  by Rust (the oracle) via the golden-update mechanism.

## Adding a case

1. Create a new `.json` file in this directory with `name`, `description`, and
   `events` (omit `expected` or set it to `{}`).
2. Run `UPDATE_FOLD_CORPUS=1 cargo nextest run -p pantoken-protocol fold_corpus_update_golden`
   to generate the `expected` field.
3. Run `cargo nextest run -p pantoken-protocol fold_corpus` (Rust) and
   `bun test protocol/src/state.corpus.test.ts` (TS) to verify both sides agree.

## Regenerating `expected`

When the fold logic changes intentionally, regenerate all golden values:

```bash
UPDATE_FOLD_CORPUS=1 cargo nextest run -p pantoken-protocol fold_corpus_update_golden
```

Then verify both test suites still pass:

```bash
cargo nextest run -p pantoken-protocol fold_corpus
bun test protocol/src/state.corpus.test.ts
```

## How it works

- **Rust** (`tests/fold_corpus.rs`): reads each file, deserializes `events` into
  `SessionDriverEvent`, folds via `fold_all`, serializes the result to
  `serde_json::Value`, and asserts deep equality with `expected`.
- **TS** (`protocol/src/state.corpus.test.ts`): reads the same files, folds via
  `foldAll`, normalizes via `JSON.parse(JSON.stringify(...))` to strip
  `undefined` fields, and asserts `toEqual(expected)`.

Both sides compare against the JSON wire shape — the same representation that
crosses the WebSocket. This catches serialization-level parity mismatches
(e.g. `null` vs absent keys) that in-memory equality would miss.
