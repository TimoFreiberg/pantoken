# Pantoken build-system migration roadmap

## Recommendation

Adopt the staged direction in the session summary, but do not create a single “migrate Pantoken to Bazel” ticket. The work should be split into independently reversible tickets, with a measured Bazel proof of concept before any broad migration.

The dependency shape is:

```text
just entry point ───────────────────────────────────────────────┐
                                                               │
toolchain baseline → Node portability → pnpm experiment ───────┤
                                                               ├→ broader Bazel migration
                       baseline → Rust/artifact Bazel POC ─────┤
                                                               │
                         hybrid-boundary decision ──────────────┘
```

The pnpm experiment does **not** need to block the initial Bazel proof of concept. It should land before substantial JavaScript/frontend targets move into Bazel.

## Phase 1 — Complete: the `just` entry point

**Status: complete.**

The `justfile` now exposes discoverable, delegation-only recipes for every routine
workflow, thin-wrapping the authoritative package, Rust, Playwright, and release
scripts:

- setup (`install` → `bun install --frozen-lockfile`);
- development (`dev`);
- aggregate TypeScript/client checks (`check` → `bun run check`);
- unit tests (`test` → `bun test`);
- Rust fmt/clippy/nextest (`check-rs` → `bun run check:rs`);
- frontend production build (`build-client` → `bun run build`);
- default and live E2E tiers (`e2e`, `e2e-live`);
- a quick default quality gate (`quality` → `check` + `test`);
- headless artifact build, validation, smoke testing, and metadata merging;
- desktop release and publish scripts.

There is no standalone JS formatter (no Prettier/Biome is configured); formatting is
covered by `cargo fmt --check` inside `check-rs`. `README.md` and `AGENTS.md` now lead
with `just` commands and note that direct `bun`/`cargo`/Playwright commands remain
supported for targeted debugging.

This satisfies Ticket 1's acceptance criteria: `just --list` reveals the workflows,
every routine workflow has a recipe or an explicit reason it remains direct, recipes
are delegation-only, and direct ecosystem commands remain available.

### Ticket 1 — Finish making `just` the project tooling entry point ✅

**Status: complete.** (Original spec retained below for the record.)

**Goal:** Make `just` the discoverable interface for supported setup, development, checks, tests, builds, E2E, and release validation without making direct ecosystem commands unavailable.

**Scope:**

- Add thin recipes that delegate to the existing authoritative package, Rust, Playwright, and release commands.
- Preserve targeted fast paths as well as an aggregate local gate.
- Distinguish quick/default checks from expensive, platform-specific, live, and release operations in recipe names and comments.
- Update `README.md`, `AGENTS.md`, and relevant CI terminology to use recipe names where practical.
- Include prerequisite/setup documentation, but do not silently install or upgrade tools.
- Keep direct Bun, Cargo, and Playwright commands supported for targeted debugging and development.

**Acceptance criteria:**

- `just` and `just --list` reveal the supported workflows to a new contributor.
- Every documented routine workflow has a corresponding recipe or an explicit reason it remains direct.
- Recipes are delegation-only and do not become a second implementation of project behavior.
- Existing CI and local checks remain green.

## Migration tickets

> These tickets are intended to be tracked as GitHub issues. Each is self-contained —
> copy the **Goal** / **Tasks** (or **Scope**) / **Exit gate** as the issue body and the
> heading as the title. Cross-references like "Ticket N" should be replaced with issue
> links (`#NN`) once the issues exist. The
> [Non-negotiable safeguards](#non-negotiable-safeguards) apply to every migration
> ticket; consider linking this roadmap from each issue.

### Ticket 2 — Pin and baseline the current toolchain ✅

**Status: complete** ([#97](https://github.com/TimoFreiberg/pantoken/issues/97)).
See [`docs/toolchain-baseline.md`](toolchain-baseline.md) for the baseline.

**Goal:** Establish a reproducible pre-migration baseline so later failures can be attributed to the migration rather than floating tools or pre-existing drift.

**Tasks:**

- Pin the Bun and Rust versions currently used by local development and CI; record Node/pnpm versions once Node portability work begins.
- Record the checks, unit and E2E tiers, production builds, and release dry-run/smoke paths that must remain valid.
- Preserve Bun dependency release-age protection, or explicitly identify its replacement and the decision owner.
- Capture representative clean/warm timings for Rust builds, client-only and Rust-only changes, unit checks, E2E, and isolated jj workspace startup.
- Keep measurements lightweight: they are comparison points, not a performance program.

**Exit gate:** The baseline scenarios and tool versions are documented and reproducible from a clean checkout.

### Ticket 3 — Remove Bun runtime and test-runner coupling ✅

**Status:** Complete ([issue #98](https://github.com/TimoFreiberg/pantoken/issues/98)).

**Goal:** Make TypeScript scripts and tests Node-compatible while retaining Bun as the package manager for now.

**Done:**
- Replaced `bun:test` with Vitest across all 56 test files (import swap).
- Added `vitest.config.ts` with `setupFiles`, include patterns, forks pool.
- Created `scripts/lib/node-compat.ts` with `spawnAsync`, `spawnManaged`, `streamText`, `isMain`, `sleep` helpers.
- Migrated all `Bun.spawn`, `Bun.file`, `Bun.write`, `Bun.sleep`, `Bun.connect`, `Bun.resolveSync`, `import.meta.main/dir/path` usages to Node-standard equivalents.
- Tests pass under both `bunx vitest run` (Bun) and `npx vitest run` (Node).
- `just quality` (check + test) passes.

### Ticket 4 — Experimentally migrate package management to pnpm

**Goal:** Determine whether pnpm can replace Bun as the sole JavaScript package/workspace manager.

**Tasks:**

- Pin Node and pnpm; use pnpm as the likely choice and fall back to npm only for a concrete blocker.
- Preserve workspace relationships, executable resolution, lifecycle behavior, Playwright setup, Vite/Svelte development, desktop tooling, and release scripts.
- Retain exactly one authoritative JS lockfile after success.
- Replace Bun’s package release-age protection with an equivalent control, or record an explicit decision to lose it.
- Detect accidental reliance on undeclared or hoisted transitive dependencies.
- Compare cold and warm installs in ordinary and isolated jj workspaces.
- Keep direct non-Bazel Vite development working.
- Define a rollback point before removing Bun-specific configuration.

**Decision gate:** Keep pnpm only if checks, E2E, builds, release validation, and developer workflows remain sound. Otherwise revert the package-manager change and document the blocker; the Rust/artifact Bazel POC may proceed independently.

### Ticket 5 — Evaluate Bazel with a narrow Rust and artifact proof of concept

**Goal:** Test whether Bazel provides enough measurable value to justify ongoing ownership.

**Initial boundary:** selected Rust builds/tests, deterministic fake-daemon or corpus validation, and headless payload/unsigned archive assembly and validation.

**Do not initially include:** Vite HMR, Apple signing/notarization, publishing, credentials, or the full Playwright matrix.

**Tasks:**

- Keep Cargo and pnpm workflows authoritative during the experiment.
- Compare clean and warm behavior against Ticket 2’s baseline.
- Exercise cache reuse across separate jj workspaces and, if feasible, CI or another machine.
- Verify cache correctness when source, configuration, generated inputs, environment, or packaging inputs change.
- Evaluate failure readability, debugging, dependency updates, target maintenance, and developer ergonomics—not only warm-cache speed.

**Decision gate:** Proceed only if the experiment shows meaningful value in reproducibility, affected-target execution, test/artifact caching, or cross-workspace/CI reuse. Otherwise record the result and stop Bazel expansion without treating the POC as a failure of the existing build.

### Ticket 6 — Define Pantoken’s hybrid Bazel boundary

**Goal:** Make a short architecture decision before broad target migration.

Decide explicitly:

- whether Bazel owns all Rust builds or only CI/release builds;
- whether production frontend builds move under Bazel while Vite remains direct for development;
- whether JS unit tests and type checks become Bazel targets;
- how generated daemon types and protocol parity checks enter the graph;
- which Playwright tiers, if any, run under Bazel;
- which unsigned desktop/headless artifacts Bazel produces;
- where signing, notarization, credentials, deployment, and publishing remain external;
- whether Cargo and pnpm remain supported direct interfaces for targeted development;
- what success criteria justify the added complexity.

**Exit gate:** The boundary, non-goals, ownership model, and rollback strategy are written down and approved before migration proper.

### Ticket 7 — Establish Bazel toolchains, rules, and dependency policy

**Goal:** Create a maintainable foundation without migrating every application target.

**Tasks:**

- Pin Bazel, rules, language toolchains, and external dependencies.
- Define supported host and target platforms.
- Establish conventions for targets, tests, generated files, tags, timeouts, visibility, and platform-specific behavior.
- Define how Cargo and pnpm lockfiles interact with Bazel dependency resolution.
- Define one documented and verifiable dependency-update workflow.
- Require sandboxing and undeclared-input detection where supported.
- Keep generated metadata free of machine- or workspace-local absolute paths.
- Document ownership without copying Polytoken’s full per-crate bureaucracy.

### Ticket 8 — Migrate deterministic Rust targets and integration tests

**Goal:** Move high-value hermetic Rust work into the Bazel graph.

**Suggested order:** Rust libraries/unit tests; server binaries/integration tests; generated daemon contract types and freshness checks; protocol corpus/parity tests; fake-daemon live-path tests.

Each target must declare inputs and produce deterministic outputs where feasible. Keep Cargo targets available until parity is demonstrated, avoid whole-repository invalidation, and preserve fast targeted development.

### Ticket 9 — Migrate headless artifact assembly and validation

**Goal:** Make unsigned headless binaries, payloads, archives, validators, metadata, and archive checks reproducible Bazel outputs where the agreed boundary permits.

Keep secret-bearing signing, publishing, and deployment outside ordinary cacheable actions. Preserve release smoke tests and archive path-safety validation.

### Ticket 10 — Migrate production frontend checks and bundles

**Goal:** Move only the frontend checks and production bundle justified by the boundary decision into Bazel.

Keep direct pnpm/Vite development and HMR. Preserve type checks, unit tests, production builds, generated assets, and declared dependency inputs. Avoid making Bazel the development server unless the POC demonstrates a clear benefit.

### Ticket 11 — Add secure remote cache and CI reuse

**Goal:** Capture cross-agent and clean-run benefits without making remote infrastructure a single point of failure.

**Requirements:**

- Treat credentials and trust boundaries as security-sensitive.
- Separate incompatible platform/toolchain/action environments.
- Define cache write permissions and untrusted pull-request behavior.
- Ensure cold or unavailable cache falls back to execution.
- Measure transfer overhead and avoid remote transfer for actions where it costs more than it saves.
- Keep signing secrets and secret-derived outputs out of shared caches.
- Add enough observability to distinguish hits, misses, invalidations, and infrastructure failures.

### Ticket 12 — Migrate CI and unsigned release assembly

**Goal:** Make Bazel authoritative for targets inside the agreed hybrid boundary.

Preserve the current CI separation between web checks, sharded E2E, Rust, macOS desktop, Linux/headless, and release gates. Keep platform-native execution where required. Make unsigned artifacts derivable from declared source and toolchain inputs, and separate cacheable production from signing, notarization, uploading, and publishing. Retain a non-Bazel fallback through at least one real release cycle.

### Ticket 13 — Retire superseded tooling and document the final workflow

**Goal:** Finish with one understandable system rather than permanent dual infrastructure.

Remove obsolete configuration, duplicate scripts, redundant CI steps, and superseded build paths only where the hybrid boundary no longer needs them. Keep intentionally retained direct pnpm/Vite and targeted Cargo workflows. Update `just --list`, onboarding, `AGENTS.md`, architecture, and release docs; document deliberate non-Bazel areas. Re-run the baseline scenarios and record the final comparison.

## Non-negotiable safeguards

- No lockfile, runtime, package manager, CI, and build-system switch in one irreversible change.
- No broad Bazel migration before the measured POC and boundary decision.
- No removal of Cargo/pnpm direct workflows until replacement parity is demonstrated.
- No signing credentials or secret-derived outputs in ordinary shared caches.
- No claim of success based only on a warm local build; include cold runs, separate jj workspaces, correctness invalidation, ergonomics, and failure behavior.
- Do not push changes as part of this roadmap without explicit approval.
