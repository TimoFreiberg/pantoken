# Default recipe — show the normal workflow and all available commands
[private]
default:
    @just --list

# --- Setup and everyday development ---

# Explicitly install the frozen dependencies; does not install prerequisites.
install:
    pnpm install --frozen-lockfile

# Start the dev server; use PANTOKEN_DRIVER=mock for UI work without a daemon.
dev *args:
    pnpm exec tsx scripts/dev.ts {{ args }}

# Aggregate TypeScript checks (normal, non-live).
check-ts:
    pnpm run check

# Run the project unit tests (TypeScript).
test-ts:
    pnpm run test

# CI-equivalent local gate. Runs all applicable host gates in parallel and retains failed logs.
# Controls: PANTOKEN_CI_CPUS, PANTOKEN_CI_E2E_SHARDS, PANTOKEN_CI_RETAIN_LOGS=1.
ci-local:
    pnpm exec tsx scripts/ci-local.ts

# Full local gate: TypeScript checks + unit tests + Rust fmt/clippy/build/test.
check:
    just check-ts && just check-rs

# Full local gate: TypeScript tests + Rust tests.
test:
    just test-ts && just test-rs

# Quick local gate: TypeScript checks followed by unit tests; no Rust or E2E.
quality:
    pnpm exec tsx scripts/check-test-env-mutations.ts
    just check-ts
    just test-ts

# Full Rust formatting, clippy, and buck2 build+test gate.
# Uses buck2 for clippy+build+test (remote cache auto-read from .buckconfig.local).
# cargo fmt remains a fast cargo command (no cache benefit).
check-rs:
    cargo fmt --all -- --check
    just buck2-clippy
    just build-rs && just build-server-rs && just test-rs

# Build the client production bundle.
build-client:
    pnpm run build

# Run the default mock-driver Playwright suite; extra args pass to Playwright.
e2e *args:
    pnpm run test:e2e {{ args }}

# Run the corpus-backed live-driver E2E tier (expensive/provider-dependent).
e2e-live *args:
    pnpm run test:e2e:live {{ args }}

# --- Workspace and issue tooling ---

# Spawn a polytoken TUI agent to implement a GitHub issue.
# Usage: just implement-issue <issue-url>
# just implement-issue --dry-run <issue-url>  (print commands, don't execute)
implement-issue *args:
    pnpm exec tsx scripts/implement-issue.ts {{ args }}

# Integrate the current workspace's commits onto main.
# Acquires a repo-local lock, pulls, rebases, tests, pushes.
# Exit codes: 0=success, 2=conflicts (lock held, resolve and retry), 1=error
integrate-into-main issue-number:
    scripts/integrate-into-main.sh {{ issue-number }}

# Create an issue workspace from the default jj workspace.
# Usage: just create-workspace <name> [revision]
create-workspace name revision="main":
    scripts/create-workspace.sh {{ name }} {{ revision }}

# Clean up the current integrated issue workspace (must run inside it).
# Usage: just cleanup-current-workspace
cleanup-current-workspace:
    scripts/cleanup-current-workspace.sh

# Legacy manual name-based cleanup; prefer cleanup-current-workspace.
# Usage: just cleanup-workspace <workspace-name>
cleanup-workspace workspace-name:
    scripts/cleanup-workspace.sh {{ workspace-name }}

# --- Code generation, fixtures, and validation ---

# Capture representative toolchain baseline timings (prints markdown table).
baseline-timings:
    bash scripts/capture-baseline-timings.sh

# Build the Rust sidecar used by the desktop app (platform-specific).
build-hub *args:
    pnpm exec tsx scripts/desktop/build-hub.ts {{ args }}

# Regenerate Rust daemon types after a polytoken daemon bump.
codegen-polytoken-rs:
    pnpm exec tsx scripts/codegen-polytoken-rs.ts

# Capture or recanonicalize the live daemon corpus (expensive/provider-dependent).
capture-daemon-corpus *args:
    pnpm exec tsx scripts/capture-daemon-corpus.ts {{ args }}

# Create all Docker daemon fixtures.
docker-fixtures-setup:
    bash scripts/docker-fixtures/setup-all.sh

# Tear down all Docker daemon fixtures.
docker-fixtures-teardown:
    bash scripts/docker-fixtures/teardown-all.sh

# --- Headless artifacts and release (expensive/credential-bearing) ---

# Build a headless release artifact.
build-headless *args:
    pnpm exec tsx scripts/headless/build.ts {{ args }}

# Validate a headless release archive.
validate-headless-artifact *args:
    pnpm exec tsx scripts/headless/validate-artifact.ts {{ args }}

# Smoke-test an extracted headless release payload.
smoke-test-headless *args:
    pnpm exec tsx scripts/headless/smoke-test.ts {{ args }}

# Merge release metadata files.
merge-release-metadata *args:
    pnpm exec tsx scripts/headless/merge-metadata.ts {{ args }}

# Run credential-free release verification for the next headless release.
release-readiness *args:
    pnpm exec tsx scripts/release-readiness.ts {{ args }}

# Cut a desktop release (typechecks and readiness run before any mutation; signing/publishing remain CI workflows).
release *args:
    just check-ts
    pnpm exec tsx scripts/desktop/release.ts {{ args }}

# Publish a desktop release and its updater manifest (credentials required).
publish *args:
    pnpm exec tsx scripts/desktop/publish.ts {{ args }}

# --- Buck2 (build/test system for Rust) ---
# See docs/buck2-policy.md. Supported platforms: aarch64-apple-darwin, x86_64-unknown-linux-gnu.

# Verify Buck2, Reindeer, and Rust toolchain versions.
verify-rs:
    bash scripts/buck2/check-version.sh

# One-time setup: symlink rustc into buck2's sandbox PATH (requires sudo).
# Needed for ring and other cc-based crates. CI does this automatically.
setup-sandbox-rustc:
    bash scripts/buck2/setup-sandbox-rustc.sh

# Build all server Rust crates via Buck2 (uses remote cache if .buckconfig.local present).
build-rs:
    bash scripts/buck2/check-version.sh && buck2 build '//server/pantoken-protocol:pantoken_protocol' '//server/pantoken-daemon-types:pantoken_daemon_types' '//server/pantoken-remote-layout:pantoken_remote_layout' '//server/pantoken-tar-validate:pantoken_tar_validate'

# Run clippy via Buck2 on all server library crates (cacheable, uses remote cache).
# Equivalent to `cargo clippy -- -D warnings` but hermetic and cached.
# The [clippy.json] subtarget fails the build on any clippy error (deny_lints
# is set on the toolchain in toolchains/BUCK).
buck2-clippy:
    bash scripts/buck2/check-version.sh && buck2 build \
        '//server/pantoken-protocol:pantoken_protocol[clippy.json]' \
        '//server/pantoken-daemon-types:pantoken_daemon_types[clippy.json]' \
        '//server/pantoken-remote-layout:pantoken_remote_layout[clippy.json]' \
        '//server/pantoken-tar-validate:pantoken_tar_validate_lib[clippy.json]' \
        '//server/pantoken-server:pantoken_server_lib[clippy.json]'

# Build the pantoken-server binary via Buck2 (uses remote cache if .buckconfig.local present).
build-server-rs:
    bash scripts/buck2/check-version.sh && buck2 build '//server/pantoken-server:pantoken_server'

# Build pantoken-server via Buck2 and print the binary path.
# (Uses remote cache if .buckconfig.local present.)
server-bin-rs:
    @bash scripts/buck2/check-version.sh && buck2 build --show-output '//server/pantoken-server:pantoken_server' | tail -1 | awk '{print $$2}'

# Run all server Rust tests with Buck2's native test runner.
# Buck2 builds the test binaries, supplies declared resources/environment, and
# enforces a 15-minute timeout for the overall test invocation.
test-rs:
    bash scripts/buck2/check-version.sh && buck2 test --overall-timeout 15m '//server/...'

# Build the unsigned headless archive via Buck2 (uses remote cache if .buckconfig.local present).
archive-rs:
    bash scripts/buck2/check-version.sh && buck2 build '//:pantoken_headless_unsigned'

# Validate the unsigned headless archive via Buck2 (uses remote cache if .buckconfig.local present).
validate-archive-rs:
    bash scripts/buck2/check-version.sh && buck2 test '//:validate_headless_archive'

# Validate the RELEASE-config unsigned headless archive via Buck2.
# Passes --config-file .buckconfig.ci so the sh_test rebuilds its
# :pantoken_headless_unsigned resource under the release configuration (the one
# the CI jobs build with release_build=1); plain validate-archive-rs would
# rebuild + validate a dev-config archive.
validate-archive-rs-ci:
    bash scripts/buck2/check-version.sh && buck2 test --config-file .buckconfig.ci '//:validate_headless_archive'

# --- Buck2 remote cache (auto-read from .buckconfig.local) ---
# Buck2 auto-reads .buckconfig.local (gitignored, contains Tailscale address),
# so all buck2 commands use the remote cache when available and fall back to
# local execution when the cache is unreachable. Requires
# BUCK2_TEST_FORCE_CACHE_UPLOAD=true in the environment (set in .envrc) for
# cache uploads to work.
# See .buckconfig.local.example and docs/remote-cache-setup.md.

# List all Buck2 targets in the server tree.
targets-rs:
    bash scripts/buck2/check-version.sh && buck2 uquery 'kind(rust_library, //server/...) + kind(rust_binary, //server/...) + kind(rust_test, //server/...)'

# Regenerate the third-party/BUCK file (requires network for cargo metadata).
# Generates http_archive rules — crates are downloaded at build time with
# sha256 verification, not checked in. vendor/ is only for offline dev.
deps-regenerate-rs:
    bash scripts/buck2/check-version.sh && scripts/buck2/run-reindeer.sh buckify

# Check that Reindeer buckify produces no diff (BUCK + fixups).
# Crates are downloaded at build time via http_archive (sha256-verified),
# not from checked-in vendor sources.
deps-check-rs:
    bash scripts/buck2/check-version.sh && scripts/buck2/run-reindeer.sh buckify && test -z "$(jj diff --name-only -- third-party/BUCK third-party/fixups/)"

# Validate that Buck2 targets match the expected-target manifest.
targets-check-rs:
    bash scripts/buck2/check-version.sh && python3 scripts/buck2/check-targets.py

# Validate test inventory against expected targets.
test-inventory-check-rs:
    bash scripts/buck2/check-version.sh && python3 scripts/buck2/check-test-inventory.py

# Run the Buck2 POC measurement script.
measure-rs:
    bash scripts/buck2/measure-poc.sh

# Run bootstrap test harness (tests version-check failure paths).
check-tests-rs:
    bash buck2/test-bootstrap.sh

# Run the CI-equivalent Buck2 gate (clippy + build + test + archive + validate + manifest checks).
# Requires Buck2 + Reindeer installed (see buck2/bootstrap.sh).
# This mirrors the .github/workflows/ci.yml buck2 job (local-only, no remote cache).
ci-rs:
    just buck2-clippy
    just build-rs
    just build-server-rs
    just test-rs
    just archive-rs
    just validate-archive-rs
    just targets-check-rs
    just test-inventory-check-rs
