# Golden daemon corpus — `0.5.8`

This directory contains a provider-free, canonicalized **contract corpus** for
Pantoken's Polytoken integration. The six `0.5.8` scenarios are
`synthetic_pantoken_regression` fixtures: independently authored from public
wire schemas and Pantoken's observable event mapper. They are not daemon
recordings and do not claim capture provenance.

Each fixture must deserialize into the real Rust `SseEnvelope` / `DaemonEvent`
types. The corpus tests additionally replay every SSE frame through
`map_daemon_event`, check typed Pantoken-boundary event/effect expectations,
request presence/absence, and final accumulator invariants. Canonicalization
remains deterministic and idempotent.

## Format

Each scenario is one JSON file. The canonical shape:

```json
{
  "scenario": "streaming-turn",
  "version": "0.5.8",
  "description": "A complete assistant turn: message_start → content block "
               "stream → message_complete.",
  "canonicalization": {
    "session_id": "SESSION",
    "prompt_ids": { "<real-uuid>": "PROMPT_0" },
    "timestamps": "monotonic-from-T0"
  },
  "http": [
    {
      "method": "GET",
      "path": "/state",
      "request_body": null,
      "status": 200,
      "response_body": { }
    }
  ],
  "sse": [
    {
      "seq": 0,
      "emitted_at": "1970-01-01T00:00:00.000Z",
      "session_id": "SESSION",
      "event": { "type": "heartbeat", "timestamp": "1970-01-01T00:00:00.000Z" }
    }
  ],
  "expected_driver_events": {
    "events": [{"kind": "sessionUpdated", "min_count": 1}],
    "effects": ["fetchState"],
    "final_session": {
      "mapped_event_count_min": 1,
      "assistant_delta_count_min": 1,
      "open_block_count": 0
    },
    "required_requests": ["GET /state", "POST /prompt"],
    "forbidden_requests": ["GET /history"]
  }
}
```

### Field reference

| field                    | type      | meaning |
|--------------------------|-----------|---------|
| `scenario`               | `string`  | Canonical scenario name (matches the filename sans `.json`). |
| `version`                | `string`  | Daemon version the corpus was captured against. Dir name mirrors it. |
| `description`            | `string`  | Human-readable summary of what the scenario exercises. |
| `canonicalization`       | `object`  | Manifest of the placeholder scheme applied (see below). |
| `http`                   | `array`   | HTTP request/response pairs in arrival order. `request_body` is `null` for bodyless requests. |
| `sse`                    | `array`   | Raw SSE frames in arrival order. Each is an `SseEnvelope` (`emitted_at`, `event`, `seq`, `session_id`). |
| `expected_driver_events` | `object` | Typed Pantoken-boundary contract: stable event kinds, effects, final accumulator invariants, required requests, and forbidden requests. |

### `canonicalization` manifest

Capture is non-deterministic: session ids, prompt ids, and timestamps differ
every run. To make a corpus replay-deterministic, the capture script applies a
placeholder scheme and records it here:

- **`session_id`** → `SESSION`. The single daemon session id is replaced.
- **`prompt_ids`** → a map `{ "<real-uuid>": "PROMPT_0" }`. Each `PromptId` seen
  across the SSE + HTTP payloads is replaced with `PROMPT_N` in first-seen order.
  `item_id` / `interrogative_id` / `call_id` style ids are left as opaque
  placeholder strings (they don't break replay determinism and aren't
  cross-referenced by the accumulator).
- **`timestamps`** → `"monotonic-from-T0"`. Every SSE envelope `emitted_at`,
  every in-event `timestamp`, and every in-event `emitted_at` is rewritten to a
  monotonic epoch starting at `1970-01-01T00:00:00.000Z` and incrementing one
  second per frame (`…00.000Z`, `…01.000Z`, `…02.000Z`, …). The original
  ordering is preserved; only the absolute instant is normalized.
- **`/state` machine-specific data** is redacted with type-preserving
  placeholders: `env` becomes `{}`, `most_recent_assistant_text` becomes `""`,
  `context_usage.used_tokens` becomes `0`, `project_cwd` becomes `"/PROJECT"`,
  and `source_control` keeps its object shape while normalizing branch/dirty and
  commit-like string leaves.

Canonicalization is **idempotent**: running it on already-canonicalized data
yields identical output. The loader test asserts this (replay determinism).

## Canonicalization procedure (re-capture on a daemon bump)

When the daemon version bumps and a fresh capture is needed:

1. Bump the version in `scripts/capture-daemon-corpus.ts` (the `VERSION`
   constant) and create the matching corpus dir.
2. Run `just capture-daemon-corpus` against a throwaway isolated daemon (the
   script uses `parity/lib.ts`'s `isolationEnv` so it never touches a prod daemon's
   sessions/config). **This spends provider money** — it drives real model turns.
   It is the deliberate, separate, operator-run step.
3. The script writes one `<scenario>.json` per scenario into the version dir,
   already canonicalized. To re-apply canonicalization to committed files without
   re-capturing or spending model tokens, run `just capture-daemon-corpus --recanon`
   (or pass explicit file paths after `--recanon`).
4. Run `cd server-rs && cargo test corpus` — the loader and contract tests confirm
   every seed event deserializes, maps to the declared Pantoken boundary, and
   remains canonical. If a public event shape changes, this fails loudly (no
   silent fallbacks).
5. Review the diff; the lead commits.

## Scenarios

| scenario | what it exercises |
|---|---|
| `streaming-turn` | A complete assistant turn: `message_start` → content-block stream (text deltas) → `message_complete`. The baseline happy path. |
| `tool-call-approval` | A tool call mid-turn that surfaces as an interrogative (permission) → user approves → `tool_result`. |
| `ask-user-question` | A model-originated `ask_user_question` (structured questions) awaiting a UI response. |
| `abort` | `POST /turn/cancel` mid-flight → `turn_cancelled` (`user_cancelled`). |
| `queue-while-in-flight` | `.7` auto-queue: a `POST /prompt` while a turn is in flight is accepted (202, `PromptAccepted.queued_item` set) and later drained. NOT rejected. |
| `reconnect-stream-discontinuity` | A `stream_discontinuity` event → the accumulator must RESEED (GET /history + GET /state), NOT attempt SSE resume replay (Last-Event-ID resume is a known upstream no-op). |

## Running the tests

```bash
cd server-rs
cargo test corpus                              # both corpus tests
cargo test corpus_loads_and_canonicalizes      # deserialization + idempotency
cargo test capture_corpus_writes_required_sections
```
