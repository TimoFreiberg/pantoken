---
name: update-polytoken-compatibility
description: >-
  Use when adopting a newer compatible Polytoken daemon version, regenerating
  OpenAPI-derived daemon types, updating the compatibility target, or auditing
  the Polytoken changelog for Pantoken behavior and schema changes.
---

# Update Polytoken compatibility

This is a daemon-adoption workflow, not a generic package dependency bump. A
codegen diff is only one input: inspect the official changelog and Pantoken's
live-driver seams before declaring the adoption complete.

## Core idea

`polytoken openapi` supplies schemas, but `polytoken --version` supplies the
release identity and compatibility target. OpenAPI `info.version` is static and
misleading. The checked-in corpus is a separate deterministic baseline; a
codegen bump does not prove live protocol compatibility and must not silently
trigger provider-backed recapture.

## 1. Preflight and record the baseline

1. From the repository root, run `jj status`. Use `jj diff --git` when existing
   edits need inspection. Stop unless the working copy is clean or the operator
   explicitly authorizes proceeding with unrelated changes.
2. Identify the exact daemon binary: `PANTOKEN_POLYTOKEN_BIN` if set, otherwise
   `polytoken` on `PATH`. Run `"$PANTOKEN_POLYTOKEN_BIN" --version` when the
   override is set, or `polytoken --version` otherwise, and record the complete
   output. Use that same resolved binary for codegen.
3. Record the old generated target, requested new version, current corpus
   version, and whether the daemon is stable or prerelease. Distinguish the
   compatibility floor from proof that the live protocol is compatible.
4. Keep a list of every file touched by this adoption. If rollback is needed,
   restore only that list so unrelated work is preserved.

## 2. Audit every intervening release

Use the official changelog: <https://docs.polytoken.dev/changelog/>.

1. Enumerate its release headings and links, then fetch/read every release from
   the old target through the requested version, including prereleases. Record
   each reviewed version, URL, access date, and the complete reviewed range in
   the bump change or PR description. A missing interval or incomplete official
   source is a stop condition; generated-diff review is not a substitute.
2. Review each release against this checklist:
   - HTTP/auth, especially bearer tokens and 401 behavior;
   - SSE event vocabulary, partial streams, reconnect and recovery semantics;
   - prompt queueing (including queued `/prompt`), history, rewind, attach, and
     session lifecycle;
   - permissions, interrogatives, compaction, and coalesced notifications;
   - configuration, model, and provider schema, including new config fields;
   - hooks, MCP, subagents, and CLI/operational behavior Pantoken uses.
3. For every relevant item, inspect the narrow corresponding seam and record
   evidence and one disposition: **no action**, **generated-type-only**, **code
   change required**, **test/fixture change required**,
   **documentation/operational follow-up**, or **blocker**. Relevant seams
   include:
   `server-rs/pantoken-server/src/polytoken/{daemon_client,event_map,ui_bridge,driver,history_seed,config_notify,config_watcher,commands,facets,models,sessions_registry,corpus}.rs`,
   `server-rs/pantoken-server/tests/corpus.rs`, and, for install semantics,
   `desktop/src/provisioning/{polytoken_compat,polytoken_install,reconcile}.rs`.
   Do not silently dismiss changelog behavior.

## 3. Regenerate and inspect the contract

1. Run `just codegen-polytoken-rs` against the exact binary. This invokes
   `scripts/codegen-polytoken-rs.ts`, whose generated output is
   `server-rs/pantoken-daemon-types/src/lib.rs`.
2. Never hand-edit the generated Rust file. Review its diff for schema
   additions/removals, requiredness and type changes, enum/discriminator
   changes, event variants, endpoint response shapes, and the embedded
   `POLYTOKEN_DAEMON_TARGET_VERSION`.
3. If generation fails, the version is unparsable, `DaemonEvent` is absent, or
   the generated contract exposes an unsupported breaking shape, stop and
   report the concrete failure. Do not weaken the generator or add permissive
   fallbacks.
4. Search compile errors and ignored/forward-compatibility tests around
   `event_map`, `daemon_client`, and `ui_bridge`. Change handwritten adapters
   only when the changelog or spec requires it; keep them separate from
   generated code.

## 4. Decide what to do with the golden corpus

The corpus under `server-rs/tests/corpus/` is the deterministic spec-drift gate.
It may remain pinned while codegen is evaluated.

**Evaluate codegen only:** retain the existing corpus and state in the bump
record that it is an intentional separate baseline. Still run corpus
serialization/deserialization and conformance tests. Never fabricate expected
driver events or silently recapture.

**Consciously adopt live behavior:** set and verify `CORPUS_VERSION` in
`scripts/capture-daemon-corpus.ts`, create a new matching version directory
rather than overwriting the sole baseline, and review every scenario's `version`
metadata and the complete diff. Capture without `--write` is a dry-run for file
output but still launches an isolated real daemon/model turn and can incur
provider cost; only `--write` writes captures. Run
`pnpm exec vitest run scripts/capture-daemon-corpus.test.ts` for the capture-
script canonicalization test and:

```bash
cd server-rs && cargo test -p pantoken-server --test corpus
```

Require explicit operator approval before removing or replacing an older corpus.

## 5. Validate and report completion

After codegen or handwritten changes, run the applicable gates:

```bash
just check
just check-rs
cd server-rs && cargo test -p pantoken-server --test corpus
```

When live behavior changed, also run `just e2e-live` (the corpus-backed live
E2E tier) or the narrower applicable fake/live integration test, plus targeted
checks for observable UI or driver changes. If any gate fails, record the
failure and touched-file list, then use file-scoped
`jj restore -- <touched files>` (or the repository-approved equivalent). Verify
with `jj status` and the diff. Never use a broad workspace reset or claim
compatibility after a failed gate.

The final bump summary names the adopted daemon version, generated files,
every changelog release reviewed and its disposition, corpus decision, commands
and results, and remaining risks or blockers. Link compatibility/corpus
rationale in `docs/DECISIONS.md` and `docs/DESIGN.md` rather than duplicating
project history.

## Common mistakes

- Using OpenAPI `info.version` instead of `polytoken --version`.
- Treating regeneration as sufficient proof of compatibility.
- Silently refreshing or overwriting the corpus.
- Ignoring intervening changelog behavior, especially auth, queued prompts,
  `history.emitted_at`, partial-stream recovery, coalesced notifications,
  attach/rewind/compaction, or new configuration fields.
- Hand-editing generated Rust types.
- Running live capture accidentally: even a no-`--write` capture can consume a
  provider-backed daemon/model turn.

For repository-specific quality review conventions, use the sibling
[`quality-review`](../quality-review/SKILL.md) skill when available. Follow the
repository's documented jj workflow for source-control operations.
