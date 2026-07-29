# Remaining Work — Polytoken Compatibility Plan

**Workspace:** `/Users/timo/src/pantoken/.workspaces/compatibility-wip`
**Plan file:** `~/.local/share/polytoken/sessions/076arg-fog/plan-001.md`
**Branch base:** `main` (21 commits on top)

## What's done (Phases 1–4, partial Phase 5)

### Phase 1 — Compatibility inventory ✓
- `endpoint_inventory.rs` (451 lines) with endpoint/event-disposition classification
- `event_map.rs` has `daemon_event_disposition_is_exhaustive` test (AC.4)
- Event disposition mapping clarified (`uwzvtxrsunuq`)

### Phase 2 — Lossless attach hydration ✓
- `attach_subscribes_before_snapshot_and_delivers_buffered_event_once` (AC.1)
- `attach_failure_tears_down_subscription_lease_and_heartbeat` (AC.2)
- in `tests/live_path.rs`

### Phase 3 — HTTP command semantics fail loud ✓
- `daemon_client_endpoint_contract_matrix` — all 36 endpoint rows (AC.3)
- `daemon_client_auth_matrix` — auth on GET/POST/DELETE/SSE/heartbeat
- `terminate_rejects_http_errors` (AC.3 specific fix)
- `tests/daemon_client_contract_tests.rs` (1805 lines, comprehensive)
- Branch error propagation: `branch_rewind_rejection_preserves_warm_session_and_public_error` (AC.6)
- Branch text preservation: `branch_rewind_acceptance_preserves_prompt_domains_and_reseeds` (AC.5)

### Phase 4 — Rewind/branch behavior ✓
- `branch_rewind_preserves_editor_text_lookup` (unit, driver.rs)
- `branch_rewind_missing_text_is_non_destructive_precondition` (unit, driver.rs)
- `branch_rewind_rejection_preserves_warm_session_and_public_error` (AC.6)
- `branch_rewind_acceptance_preserves_prompt_domains_and_reseeds` (AC.5)
- `branch_rewind_refresh_failure_invalidates_stale_warm_session`

### Phase 5 — Corpus/fake daemon layered suite (PARTIAL)
- **Done:**
  - Provenance validation: `corpus_provenance_is_complete` (AC.7)
  - Typed driver contracts: `corpus_expected_driver_contracts_match` (AC.7)
  - Final state invariants: `corpus_final_state_invariants_match` (AC.7)
  - Corpus README updated with provenance/layered-proof language
  - 6 corpus scenarios migrated to typed stable Pantoken-boundary expectations
  - Strict fake daemon: `fake_daemon_rejects_unexpected_request`, `fake_daemon_checks_body_order_and_count`, `bootstrap_allowlist_has_contract_tests` (AC.8)
  - `active_version()` + deprecated `sole_version()` shim (AC.10 partial)
  - `capture-daemon-corpus.ts` requires `--version` + `--write`, refuses overwrite without `--force` (AC.10)

- **Missing:**
  1. **Deterministic gap scenarios (AC.9)** — None of the 10 named contract scenario tests exist yet:
     - `contract_attach_hydration_race`
     - `contract_auth_failures`
     - `contract_lease_lifecycle`
     - `contract_multi_item_queue`
     - `contract_rewind`
     - `contract_reconnect_reseed`
     - `contract_history_projection`
     - `contract_state_invalidation`
     - `contract_event_dispositions`
     - `contract_action_errors`
  2. **Coverage report test (Phase 5.8)** — no coverage map test that prints endpoint/event/state/history/scenario coverage and fails on unclassified additions
  3. **Multiple corpus version coexistence test (AC.10)** — `multiple_corpus_versions_load_with_explicit_active_selector` not found
  4. **Capture-script Vitest tests (AC.10)** — `capture_refuses_existing_version_without_explicit_override` not found in test files

---

## Remaining work, grouped for parallel sessions

### Session A: Deterministic gap scenarios (Phase 5.5, AC.9)
**Scope:** Author the 10 named contract scenario tests listed above.

These are deterministic, provider-free scenarios that exercise specific compatibility gaps. Each should use the strict fake daemon (no permissive canned responses) and assert Pantoken-boundary observable behavior.

**Key gaps to cover:**
- Attach race (event during snapshot hydration — already covered in live_path.rs but needs a corpus-level contract scenario)
- Auth failures and malformed bodies
- Lease conflict/expiry/loss
- Multi-item queue drain and queue errors
- Rewind accepted/rejected with reseed
- Reconnect/discontinuity and interrupted partial content
- History hydration with every projected history kind
- State invalidation domains and authoritative refetch
- Current events: mapped, refetching, reseeding, notices, intentional no-ops
- Command/action error propagation

**Files to touch:** `server-rs/pantoken-server/tests/corpus.rs` or new test files under `server-rs/tests/`. New corpus scenario JSON files under `server-rs/tests/corpus/0.5.8/` as needed.

**Acceptance:** AC.9 — all 10 named tests exist and pass.

### Session B: Coverage report + corpus version coexistence + capture tests (Phase 5.6–5.8, AC.10)
**Scope:**
1. Add `coverage_report` test (Phase 5.8) that maps endpoint, event-disposition, state/history kind, and scenario coverage; fails on unclassified public-contract additions (not on arbitrary percentage).
2. Add `multiple_corpus_versions_load_with_explicit_active_selector` test (AC.10) — create a second (synthetic) version dir and prove both load while only the active one is selected.
3. Add capture-script Vitest tests: `capture_refuses_existing_version_without_explicit_override` (AC.10) — assert `captureTarget()` refuses to overwrite without `--force`.

**Files to touch:** `server-rs/pantoken-server/tests/corpus.rs`, `scripts/capture-daemon-corpus.ts` (test section), possibly `server-rs/tests/corpus/` for a synthetic second version.

**Acceptance:** AC.10 fully met; Phase 5.8 coverage gate exists.

### Session C: Live E2E expansion + CI promotion (Phase 6, AC.11)
**Scope:**
1. Expand `e2e/live/` specs for supported user-visible flows beyond the current 5 (abort, approval, ask, queue, streaming):
   - Rewind/edit-and-resend restores composer text (AC.5 E2E)
   - Rewind rejection is actionable (AC.6 E2E)
   - Permission/Q&A resolution
   - Reconnect/reseed
   - Action error notices
2. Remove the `workflow_dispatch`-only gate from the `web-live` CI job (Phase 6.3). The job already runs `PANTOKEN_DRIVER=fake` (provider-free), so this is safe once specs pass.
3. Add a CI configuration check test asserting `web-live` is not `workflow_dispatch`-only.

**Files to touch:** `e2e/live/*.e2e.ts`, `.github/workflows/ci.yml`.

**Acceptance:** AC.11 — live/fake Playwright tier validates strengthened flows and runs as blocking CI job.

### Session D: Private-source boundary scan + documentation (Phase 5/6 + Documentation Strategy)
**Scope:**
1. Add `private_source_boundary` repository scan (AC.12) — rejects known local-source checkout references/dependencies in tracked build/config/test files. Must use generic policy markers, not developer-specific paths.
2. Update `docs/DECISIONS.md` with compatibility proof boundaries (what schema generation, black-box contracts, captured canaries, fake/live E2E each prove).
3. Update `docs/TODO.md` entries for completed/remaining compatibility work.
4. Update `server-rs/PROGRESS.md` to reflect the current state accurately.
5. Ensure all committed wording is public-safe (no private source citations).

**Files to touch:** New test file for the boundary scan, `docs/DECISIONS.md`, `docs/TODO.md`, `server-rs/PROGRESS.md`.

**Acceptance:** AC.12; Documentation Strategy items completed.

### Session E: Final verification, quality review, and commit (Phase 6.4–6.5, Review Strategy)
**Scope:**
1. Run all required checks:
   - `cd server-rs && cargo test -p pantoken-server --test corpus`
   - `cd server-rs && cargo test -p pantoken-server --test daemon_client_contract_tests`
   - `cd server-rs && cargo test -p pantoken-server --test live_path`
   - `just check-rs`
   - `just check`
   - `just e2e-live`
   - `just e2e` (mock regression safety)
2. Run `quality-review` skill (mandatory per Review Strategy).
3. Run `review-subagent` pass focused on: transport races, cleanup, fixture provenance, confidentiality boundaries, and whether tests would fail if each new behavior were removed.
4. Fix or rebut every finding; repeat until no critical findings.
5. Review final diff with `jj diff --git -r main..@`.
6. Ensure all commits have proper messages (no empty descriptions).

**Acceptance:** All AC met; review findings resolved.

### Session F: Workspace cleanup (Todo 8)
**Scope:**
1. After all work is integrated, verify the compatibility-wip commits are retained.
2. From the default workspace, run `jj workspace forget compatibility-wip`.
3. Remove `.workspaces/compatibility-wip`.

**Note:** Only run after Session E completes and the operator confirms integration.

---

## Session dependency graph

```
A (gap scenarios) ─┐
B (coverage+corpus) ─┤
C (live e2e+CI)    ──┼── E (final verify+review) ── F (cleanup)
D (boundary+docs)  ──┘
```

Sessions A, B, C, D can run in parallel (independent workspaces). Session E depends on all four. Session F depends on E.

## Acceptance criteria status

| AC | Status | Session |
|----|--------|---------|
| AC.1 | ✓ done | — |
| AC.2 | ✓ done | — |
| AC.3 | ✓ done | — |
| AC.4 | ✓ done | — |
| AC.5 | ✓ done | — |
| AC.6 | ✓ done | — |
| AC.7 | ✓ done | — |
| AC.8 | ✓ done | — |
| AC.9 | ✗ missing 10 contract scenarios | A |
| AC.10 | ◐ partial — version selector + capture script done; missing version-coexistence test, capture Vitest tests | B |
| AC.11 | ✗ web-live still `workflow_dispatch`-only; missing rewind/permission/reconnect E2E specs | C |
| AC.12 | ✗ no `private_source_boundary` scan | D |
