# Rust Server — Status & Resumption Plan

**Status (2026-07-08):** Cutover complete. The TS server has been deleted; the
Rust server is the only server. 993 Rust tests green (9 daemon-types, 106
protocol, 831 server lib + integration [8 skipped], 24 tar-validate, 35
remote-layout, 87 desktop). `cargo clippy
--all-targets -- -D warnings` + `cargo fmt --check` clean. Mock-e2e burn-down
complete (Phase 1); live-path validation parts 1–2 complete (Phases 2, 2.5, 5);
6 live-path `BUG:` markers resolved (Phase A). Phase 3 `/health` real counts +
`build_sha` env + web push delivery (VAPID keygen + `/push/*` + hub `notify`)
done; `sessions-registry` (15) + `lease-retry` (11) tests ported. The TS test
files are archived in `server/ts-test-reference/` for reference when porting
remaining cases. Remaining: port `daemon-client.test.ts` subset (needs an HTTP
mock seam for setModel/subscribe; the spawn-seam + pure-helper +
waitForDaemonStartup parts are tractable now); live smoke test against a real
daemon.

**Status (2026-07-31, issue #135):** The 10 deterministic gap scenarios landed
under `server/pantoken-server/tests/contract_scenarios.rs` (the
`contract_scenarios_tests` buck2 target, registered in `just test-rs`):
attach race (strict hydration-race fake), attach-chain auth/malformed failures,
lease conflict + lease loss (heartbeat 409 → reconnect reseed), multi-item
queue drain + error pinning, rewind→reseed, reconnect discontinuity → reseed
(+ interrupted-tool-call clean-accumulator variant), full history-kind
hydration, state invalidation + rewind domains, per-disposition observability,
and command/action error propagation. Four new SSE-driven corpus scenarios
(`attach-race`, `rewind-reseed`, `state-invalidation`, `event-dispositions`)
pass the full corpus loader gate. The fake daemon gained two strict modes:
`spawn_strict_hydration_race` (attach race under strict expectation
consumption) and `spawn_strict_gated` (phased SSE injection after warm attach,
so effect-triggering events never race the seed fetch under strict global
ordering); the strict `/events` handler now also serves declared non-200
statuses. Two pre-existing behaviors are pinned by tests, NOT fixed:
the warm-time seed-path `/history` failure swallows into a bare `SessionOpened`
seed (driver.rs:2437-2455), and `clear_queue` snapshot/dequeue failures return
empty/partial `ClearQueueResult`s without surfacing the daemon error
(driver.rs:1739-1775) — both candidate follow-ups. Also fixed a pre-existing
flake in `live_path.rs`'s three `_real` remote-runtime tests: their
per-test `PANTOKEN_HUB_IDLE_MS` set/restore dance raced with concurrent
`std::env::var` reads in the multithreaded test binary, intermittently leaving
the runtime with the `2 × idle_reap_ms` hub-exit default and killing the
accept loop mid-test (`idle_gc_disposes_warm_session_real` connection-refused
on reconnect). `hub_idle_ms` is now a first-class `Config` field (read from
`PANTOKEN_HUB_IDLE_MS` in `config::load`); the `_real` tests set
`hub_idle_ms: 0` directly in their `Config` literals, eliminating the env-var
mutation entirely.

**Status (2026-07-31, issue #136):** Corpus coverage gate + version coexistence
proof landed. `coverage_report` (in `server/pantoken-server/tests/corpus.rs`,
part of the `corpus_tests` buck2 target) classifies every corpus scenario in
every version dir across four dimensions — endpoints against
`endpoint_inventory::ENDPOINTS` (query-aware, `{param}`-wildcard, method-exact
matcher), `sse[].event.type` against `event_disposition_for_wire_name`, and
`/history` `items[].type` against a hand-maintained `KNOWN_HISTORY_KINDS`
mirror of the `history_seed.rs` vocabulary — prints the map, and fails ONLY on
unclassified public-contract additions (never on coverage percentages). A
synthetic second version dir `server/tests/corpus/0.6.0-synthetic/abort.json`
(a byte-faithful copy of `0.5.8/abort.json`, re-versioned to
`0.6.0-synthetic` with `synthetic_public_schema` provenance) backs the
`multiple_corpus_versions_load_with_explicit_active_selector` coexistence
test, and every pre-existing corpus gate now validates both version dirs.
The loader gained a pure `active_version_with(Option<&str>)` selector so the
explicit-version path is testable without mutating `PANTOKEN_CORPUS_VERSION`
(process-env mutation in a multithreaded test binary is the flake vector fixed
in #135 above); `active_version()` is now a thin wrapper.
`scripts/capture-daemon-corpus.test.ts` proves `captureTarget()` refuses
overwrite without `--force` AND permits it with `--force` under the issue's
named test. The corpus README documents the coexistence dir + coverage gate and
replaces the stale `cargo test corpus` commands with the buck2 ones
(`just test-rs` / `buck2 test //server/pantoken-server:corpus_tests`).

## Phase 2 session lifecycle

Destroy-session protocol and driver seams are implemented. Empty/default mock sessions can be reaped with lifecycle guards; live sessions use a pantoken-owned durable lifecycle/tombstone store and filter tombstoned rows. Prompt acceptance and successful live configuration actions are recorded authoritatively, and warm-cap eviction prefers eligible empty/default attachments. The daemon surface exposes process termination but no registry-delete endpoint, so tombstones remain the deletion fallback.

## Goal

Replace the Bun/TS server with a Rust server implementing the same WS protocol,
HTTP endpoints, and driver behavior — validated against the e2e suite AND the
ported unit-test suite. ✅ **Done (2026-07-08):** the TS server is deleted; the
Rust server is the only server. The TS test files are archived in
`server/ts-test-reference/` for reference.

## Where the port actually stands

**Ground truth (2026-07-07, full suite, one machine — Phase 5 done):**

- `cargo test`: **993/993 pass** (9 daemon-types, 106 protocol, 831 server lib +
  integration [8 skipped], 24 tar-validate, 35 remote-layout, 87 desktop).
- `cargo clippy --all-targets -- -D warnings`: 0 warnings.
- e2e (Rust server, mock driver): 298/0 (3.0 min, `--project=desktop`). 2 known
  load-induced flakes (dir-picker, sidebar-drafts) pass in isolation.
- server is in CI: `rust-server` job runs fmt + clippy (`-D warnings`) +
  test. `just check-rs` runs the same locally.

**Phase 1 (mock-e2e cluster burn-down) — COMPLETE:** failures 33 → 0
deterministic across 7 clusters (models, queue, new-session-failure,
context-meter, reload-session, update-card, singletons), each test-first and
review-approved.

**Status (2026-07-31):** restored the TS-era mid-turn usage poll for the live
polytoken driver — `PolytokenDriver::get_usage` now returns the warm session's
cached usage and kicks a throttled (one `GET /state` per 3s), single-flight
refresh while a turn is in flight, so the context meter climbs during long
turns instead of freezing at the last turn boundary (the Rust port had left the
trait default `None`, so the hub's `refresh_usage` no-oped for live sessions).
Also clamped the context-meter percent at 100 in `usage_from_state`; the raw
token counts stay visible in the meter popup's "`tokens` / `contextWindow`
tokens" line. Driver tests: `contract_scenarios.rs` §4 (strict gated fake).

### What is done and trustworthy

- `pantoken-protocol` — wire types, fold reducer, session-driver types; ported with
  tests (36 vs TS's 38).
- `journal.rs` (17 tests), `pidlock.rs` (18), `history_seed.rs` (21 vs TS 18),
  `settings_store`, `static_serve`, `config` — ported with tests. ⚠
  `history_seed`: the ported timestamp fabrication is deletable on the next
  daemon bump (unstable.6 ships `emitted_at`); don't extend it. Also note the
  known TS bug that only 3 of 12 history kinds are replayed.
- `pantoken-daemon-types` — codegen from `polytoken 0.5.8 openapi` (178 component schemas, 178 generated declarations, 57 DaemonEvent variants).
- `daemon_client.rs` — 1:1 method-surface port including lease retry.
  **Untested** — dedicated test ports still open (Phase 2 item 4). SSE liveness
  is heartbeat-based (Phase 2.0).
- `event_map.rs` / `ui_bridge.rs` — accumulator model ported + tested
  (event-map 124 active + 5 `#[ignore]`, ui-bridge 38/38). The 5 `#[ignore]`s
  are generated-type gaps (4: closed enums reject unknown variants the TS
  forward-compat cases construct; `ProviderError::Transport` lacks a `kind`
  field) + 1 daemon-type collapse (`current_goal` single-Option can't
  distinguish present-but-omitted from null).
- `hub.rs` — all 35 ClientMessage types handled; mock-e2e-validated + ~37 ported
  unit tests. I/O-shaped live-path handlers (SSE, daemon effects) covered by
  `live_path` integration tests (Phase 2).
- `background_model.rs` — port of `resolveBackgroundModel`; 10 tests. `script:`
  path is a fail-loud stub. Only `.warning` is wired into `pantoken_settings_msg`;
  background-model *application* to turns is separate follow-up.
- `mock_driver.rs` — direct port of TS MockDriver; all fixture scripts present;
  e2e wiring works end-to-end.
- `shared/` modules — `warm_cap` (10), `session_list` (4), `login_env`
  (11 pure + impure wired), and `archive_store` (5) are ported with tests and
  wired into the live `PolytokenDriver` (Phase 5). `set_archived` +
  `login_env_status` also wired
  (2026-07-07 "leg 1" cleanup).
- `fake_daemon.rs` — runtime-controllable in-process fake daemon
  (`PANTOKEN_DRIVER=fake`); corpus-backed dev surface (`/debug/reset` + `mock` WS
  message); `e2e/live` Playwright tier (5 specs, corpus subset — D21).

**The load-bearing caveat:** test-porting stopped where the code became
I/O-shaped. The remaining gap is the I/O-shaped daemon/hub integration tests:

| TS test file | cases | Rust counterpart |
|---|---|---|
| `hub.test.ts` | 64 | 0 |
| `hub-journal.test.ts` | 14 | 0 (journal unit ≠ hub integration) |
| `daemon-client.test.ts` | 14 | 0 (subset tractable: pure helpers + spawn seam + waitForDaemonStartup; `setModel` 409 + `subscribe` liveness need an HTTP mock seam in `DaemonClient`, not yet introduced) |
| `lease-retry.test.ts` | 11 | ✅ 11 + 2 extra (ported 2026-07-08; sleep seam added) |
| `sessions-registry.test.ts` | 15 | ✅ 15 (ported 2026-07-08) |

The e2e suite runs the **mock driver only** (plus the `e2e/live` corpus-subset
tier). "e2e passes" must not be read as "the live path is validated" — the mock
tier validates hub + protocol + client; the `e2e/live` tier validates the driver
stack over a corpus-backed fake daemon.

## Live corpus capture — FROZEN (2026-07-06)

5/6 scenarios captured from a real deepseek daemon (`0.4.0-unstable.7`),
canonicalized + `/state`-redacted, no machine-specific data. Corpus is the
protocol-change canary for every polytoken bump / codegen regen.

| scenario | frames |
|---|---|
| `streaming-turn` | 22 |
| `queue-while-in-flight` | 65 |
| `abort` | 7 |
| `ask-user-question` | 291 |
| `tool-call-approval` | 74 |

**NOT captured:** `reconnect-stream-discontinuity` (requires forcing a
`stream_discontinuity`; SSE resume is an upstream no-op). Stays a seed fixture;
improved-stub the driver.

**Key findings (encoded in capture script / code, kept for re-capture reference):**
- Permission gating needs `standard` matcher + a version-2 `permissions.yaml`
  with `ask` rules (`standard` alone doesn't prompt).
- Real `/state` has **no top-level `turn_in_flight`** field.
- Real event types the seeds lacked: `notification_autodrain_switch`,
  `permission_monitor_switch`, `system_reminder`, `content_block{thinking}` +
  `signature_delta`, `session_state_changed{domains}`.
- Model thinking/text content is irreducibly non-deterministic — the corpus is a
  human-reviewed drift canary, not a byte-exact oracle.

**Grow-the-corpus path:** capture a new scenario
(`scripts/capture-daemon-corpus.ts`, operator + `$DEEPSEEK_API_KEY`), add a
`run_script` match arm + an `e2e/live` spec.

## Phase 2 live-path validation — COMPLETE

The live path (`daemon_client` → `event_map` → `driver`, ~5.7k lines) had zero
coverage. The fake-daemon harness replays the corpus through an axum router over
an ephemeral port with a `spawn_override` seam. The warm-session lifecycle is
wired, SSE ordering uses one per-session mpsc consumer task, and the
FetchState/RefetchQueue effects are implemented. The `Arc<PolytokenInner>` split
resolved the `&self`-vs-`Arc<Self>` structural knot. 19 live-path integration
tests cover the live path.

### Journal idle eviction

The hub evicts journals for sessions that have no viewers, no running turn,
and no warm daemon attachment once they've been idle past
`PANTOKEN_JOURNAL_IDLE_EVICT_MS` (default 5 min; ≤0 disables). This closes the
gap where a daemon crash leaves a journal in the hub's `journals` HashMap
forever — the SSE reconnect loop never emits a synthetic `sessionClosed`, so
the existing removal path never fires. The eviction pass runs from the existing
live-refresh ticker (no new timer/thread); it's purely synchronous under the
hub lock. A new `has_warm_session` driver trait method (default `false`;
`PolytokenDriver` overrides) prevents evicting journals for sessions with live
daemons.

## Wrong turns to undo

1. **Fake-daemon architecture — resolved.** The original fake daemon was buried
   (Phase 0.1), rebuilt in Phase 2 as a corpus-replaying axum router speaking
   real `DaemonEvent`s, and promoted in Phase 2.5 to a runtime-controllable dev
   surface (`PANTOKEN_DRIVER=fake`, `src/polytoken/fake_daemon.rs`) + `e2e/live`
   Playwright tier (D21).

2. **Live-path bugs — all resolved.** SSE per-event spawning, FetchState/
   RefetchQueue no-ops, `$HOME` workspace fabrication, `login_env` drops,
   `list_sessions` hardcoded closures, `warm_cap` unenforced,
   `set_archived`/`login_env_status` unwired — all fixed and tested (Phases 2,
   5, A).

3. **Silent-degradation — mostly resolved.** Remaining open spots:
   - ✅ `/push/*` endpoints wired (Phase 3, 2026-07-07): VAPID keygen +
     `send_to_all` delivery + hub `notify`. On-device delivery validation
     still manual (same as TS).
   - ✅ `/health` returns real client/running/initializing/busy counts
     (Phase 3, 2026-07-07).
   - ✅ `build_sha` reads `PANTOKEN_BUILD_SHA` via `option_env!` (Phase 3,
     2026-07-07); still needs a build step to set the var.
   - ✅ `POST /update/state`, error-message parity, `OpenDataDir` spawn error,
     blanket `#![allow]` — all fixed.

4. **Concurrency model — partly standing.** Hub is
   `Arc<parking_lot::Mutex<SessionHub>>`; Phase 1's completion-queue (bounded
   mpsc + single applier task, FIFO dispatch order) killed the connect-time
   fan-out races. **Still standing:** the Rust queue serializes in *dispatch*
   order (stricter than the original TS server, which fired concurrently and
   applied in completion order) — accepted for this single-user tool but noted.

5. **CI enforcement — resolved.** server is in CI (Phase 0.2).

## Resumption plan

Three standing invariants while you work:

1. **jj discipline**: review with `jj diff --git`, commit per completed task,
   imperative subject ≤72 chars, only the files you touched.
2. **Pin the corpus, not the daemon** (D20). Determinism comes from the
   committed golden SSE corpus (`server/tests/corpus/<version>/`). On a bump:
   re-run codegen, replay the corpus as the drift canary, adopt newly
   daemon-owned fields, re-capture only on conscious adoption.
3. **Port remaining TS tests.** The archived tests in
   `server/ts-test-reference/` are the reference for cases the Rust suite
   doesn't yet cover. Port them incrementally.

The cutover is **done** — all four legs passed (ported unit tests, mock e2e,
fake-daemon e2e, live-path validation). The TS server has been deleted.

### Daemon-owned first — check the changelog (standing)

Before porting, fixing, or testing any daemon-facing workaround, check
<https://docs.polytoken.dev/changelog/> and diff a fresh `polytoken openapi`
dump — prefer deleting a workaround the daemon now owns over porting it
faithfully.

> **Version status (2026-07-29):** installed and validated **0.5.8**. The fresh
> OpenAPI inventory contains 178 component schemas and 57 `DaemonEvent` variants;
> generated Rust contains 178 matching declarations. The bump adds cache-miss,
> compaction/history projection, feedback-artifact, active-plan, and response-id
> vocabulary, and removes the obsolete `CodexAuthProfile` alias. These are
> additive/unused wire shapes except for the two new events, which are explicitly
> handled as no-op notifications by the live mapper. The corpus was renamed to the
> active `0.5.8` selector and replay passes. A future bump must re-run codegen,
> refresh the checked-in OpenAPI inventory, replay/capture the corpus, update
> provisioning fixtures, and review all daemon-facing mappings.

**Confirmed still daemon-gaps (probed live, 2026-07-04):**
- SSE resume is a silent no-op — `Last-Event-ID: 100` replays nothing. Reconnect
  recovery stays reseed-on-`stream_discontinuity` until upstream implements
  resume (ask #4, reframed in `docs/polytoken-upstream-feature-asks.md`).
- `GET /events` streams with no TUI lease claimed — read-only observing may
  already exist (ask #12).

### Phase 0 — truth & guardrails — COMPLETE

- [x] Deleted as-built mock-mode remnants (`Passthrough` variant,
      `fake_daemon_url` plumbing); codegen re-run clean.
- [x] Added server to CI (`rust-server` job: fmt + clippy `-D warnings` +
      test); `just check-rs`; `Cargo.lock` tracked.
- [x] Removed blanket `#![allow(dead_code)]` / `#![allow(unused_variables)]`;
      survivors converted to item-level `#[expect]`.
- [x] Progress claims made reproducible (per-spec failure table).

### Phase 1 — mock-mode e2e to green — COMPLETE

- [x] Hub completion queue landed (bounded mpsc + single applier, FIFO dispatch
      order). Note: serializes in dispatch order (stricter than TS's completion
      order); accepted for single-user tool.
- [x] All 7 failure clusters cleared test-first, review-approved: models,
      queue, new-session-failure, context-meter, reload-session, update-card,
      singletons. Failures 33 → 0 deterministic.
- [x] Error-message parity restored (the "~17 vs ~6" gap was mostly illusory;
      one real silent spot — `OpenDataDir` — fixed).

### Phase 2 — live-path validation, part 1 — MOSTLY COMPLETE

- [x] Accumulator stays server-side Rust (D19).
- [x] `event-map.test.ts` (124+5) + `ui-bridge.test.ts` (38) ported; fixed
      `goal_driver_update` proposed-blank bug.
- [x] SSE ordering fixed (per-session mpsc consumer; 250 ordered deltas).
- [x] `FetchState` emit + `RefetchQueue` → `queueUpdated` implemented.
- [~] Corpus: 5/6 real captures FROZEN (see "Live corpus capture" above).
- [x] Fake-daemon harness built (axum router + `spawn_override`; 19 integration
      tests).
- [~] **Port `daemon-client.test.ts` + `lease-retry.test.ts` (25).** ✅
      `lease-retry.test.ts` (11) ported (2026-07-08) + a sleep seam
      (`retry_claim_with_sleep`). Spawn seam already exists
      (`spawn_override`/`set_spawn_override`). `daemon-client.test.ts` (14)
      partially tractable: pure helpers (`parse_spawn_output`,
      `parse_lease_held_error`) + the spawn seam + `waitForDaemonStartup` (file
      polling) port directly; the `setModel` 409 + `subscribe` liveness tests
      need an HTTP mock seam in `DaemonClient` (it uses `reqwest::Client`
      directly — no trait seam yet). **Open follow-ups surfaced during the
      lease-retry port:** (a) `retry_claim` retries on ANY `Err` (TS re-throws
      non-lease errors immediately) — `claim_lease` models non-409s as
      `LeaseConflictError { held: None }`, so a 500 retries 4×; fix needs a
      `LeaseError { Conflict, Other }` enum. (b) `claim_lease_with_retry`
      inlines its own retry loop and doesn't call `retry_claim` — the sleep seam
      covers the standalone fn, not the production path; dedupe to close the gap.
- [x] `shared/` modules ported with tests and wired into live driver (Phase 5).
      ✅ `sessions-registry` (15 tests) ported (2026-07-08): the Rust module
      had no tests; all 15 TS cases now mirrored (mtime sort, cold-entry
      fallbacks, archive-flag merge).
- [x] `open_session` `$HOME` fabrication fixed (reads real cwd from
      `session.json`).

### Phase 2.5 — fake-daemon e2e tier — COMPLETE

- [x] Dev surface: `PANTOKEN_DRIVER=fake` boots the real `PolytokenDriver` over an
      in-process, corpus-backed fake daemon. `/debug/reset` → `driver.reset`
      (keeps bootstrap warm for synchronous `seed_default`); `mock` WS message →
      `driver.run_script(name)` (maps script → corpus scenario, pushes SSE
      frames). Integration tests cover boot, reset, and script-push.
- [x] Playwright live tier: separate `playwright.live.config.ts` runs
      `e2e/live/*.e2e.ts` (5 specs) against `PANTOKEN_DRIVER=fake` via
      `pnpm run test:e2e:live`. Corpus SUBSET (D21), not the full mock suite.
      First run found + fixed a bootstrap bug (idle scenario synthesized;
      `run_script` arms HTTP override). All 5 pass locally. CI job `web-live`
      is gated to `workflow_dispatch`; next step is a CI dispatch run, then
      promote to PR gate.
- [ ] Revisit after cutover: if fake-daemon tier is green and comparably fast,
      consolidate to one mock (delete MockDriver) rather than carrying both.

### Phase 3 — cutover mechanics

- [~] **Bump polytoken** — mostly absorbed (unstable.6/5 work done). What
      remains: the mechanical bump ritual for the *next* release (re-run
      codegen, replay corpus as drift canary, adopt daemon-owned fields,
      re-capture on conscious adoption).
- [ ] **Live smoke** as the final gate: drive a real daemon session through the
      GUI (new session, prompt, stream, approve a tool, switch model/facet,
      abort, archive); diff `/debug/state` for sanity.
- [x] `/health`: real client/running/initializing/busy counts. (2026-07-07)
      `client_count()` mirrors TS `clientCount()`; the handler returns
      `{ok, clients, running, initializing, busy}` matching the TS shape.
- [~] Push: VAPID keygen + web-push delivery + `/push/*` endpoints + hub
      `notify` wired (2026-07-07). VAPID keypair via `jwt-simple` `pure-rust`
      (no BoringSSL/cmake); `send_to_all` fans out concurrently via
      `join_all`; 404/410 → prune. **Still manual:** on-device delivery
      validation (same as TS — the crypto/HTTP path can't be unit-tested
      without a mock push service; `is_dead_status`/`classify_send_result`
      are the tested pure helpers).
- [~] `build_sha` from the dist marker — reads `PANTOKEN_BUILD_SHA` at compile
      time via `option_env!` (empty in dev). Still needs a build step (CI /
      `build.rs`) to actually set the var; the read path is wired.
- [x] Flip the default server impl — **done (2026-07-08):** TS server deleted,
      Rust server is the only server. AGENTS.md, docs/DECISIONS.md,
      docs/TODO.md, package.json scripts, CI, deploy scripts, desktop app, and
      dev tooling all updated.

### Non-goals (explicitly)

- Don't rebase the existing e2e suite off MockDriver during the burn-down — the
  fake-daemon tier is **added**, not swapped in.
- No Passthrough-style shortcuts in the fake daemon: if it doesn't speak real
  `DaemonEvent`s end to end, it validates nothing.
- Don't rewrite the hub as a full actor; the completion-queue-over-mutex
  discipline is the chosen middle ground.
- Don't chase individual e2e specs with special-cased fixes; every fix lands
  with its ported unit tests.

## How to verify current state

```bash
cd server && cargo test                      # 993 tests, green
cd server && cargo clippy --all-targets -- -D warnings   # 0 warnings
just check-rs                                     # fmt + clippy + buck2 build+test locally (CI gate)
pnpm run test:e2e                               # mock-driver e2e (298/0; 2 load-induced flakes)
pnpm run test:e2e:live                          # corpus-subset live tier vs fake daemon (5 specs)
```
