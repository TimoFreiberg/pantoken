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

# Aggregate TypeScript/client checks (normal, non-live).
check:
    pnpm run check

# Run the project unit tests (normal, non-live).
test:
    pnpm run test

# Quick local gate: check followed by unit tests; no Rust, E2E, or live work.
quality:
    just check
    just test

# Full Rust formatting, clippy, and buck2 build+test gate.
# Uses buck2 for clippy+build+test (remote cache auto-read from .buckconfig.local).
# cargo fmt remains a fast cargo command (no cache benefit).
check-rs:
    cargo fmt --all -- --check
    just buck2-clippy
    just buck2-build && just buck2-build-server && just buck2-test

# Cargo-only Rust gate (fmt + clippy + nextest). Fallback for debugging.
check-rs-cargo:
    pnpm run check:rs

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

# Cut a desktop release (credential/signing workflow).
release *args:
    pnpm exec tsx scripts/desktop/release.ts {{ args }}

# Publish a desktop release and its updater manifest (credentials required).
publish *args:
    pnpm exec tsx scripts/desktop/publish.ts {{ args }}

# --- Buck2 (primary build/test system for Rust) ---
# See docs/buck2-policy.md. Cargo is the fallback (just check-rs-cargo).
# Supported platforms: aarch64-apple-darwin, x86_64-unknown-linux-gnu.

# Verify Buck2, Reindeer, and Rust toolchain versions.
buck2-check:
    bash scripts/buck2/check-version.sh

# Build all server-rs Rust crates via Buck2 (uses remote cache if .buckconfig.local present).
buck2-build:
    bash scripts/buck2/check-version.sh && buck2 build '//server-rs/pantoken-protocol:pantoken_protocol' '//server-rs/pantoken-daemon-types:pantoken_daemon_types' '//server-rs/pantoken-remote-layout:pantoken_remote_layout' '//server-rs/pantoken-tar-validate:pantoken_tar_validate'

# Run clippy via Buck2 on all server-rs library crates (cacheable, uses remote cache).
# Equivalent to `cargo clippy -- -D warnings` but hermetic and cached.
# The [clippy.json] subtarget fails the build on any clippy error (deny_lints
# is set on the toolchain in toolchains/BUCK).
buck2-clippy:
    bash scripts/buck2/check-version.sh && buck2 build \
        '//server-rs/pantoken-protocol:pantoken_protocol[clippy.json]' \
        '//server-rs/pantoken-daemon-types:pantoken_daemon_types[clippy.json]' \
        '//server-rs/pantoken-remote-layout:pantoken_remote_layout[clippy.json]' \
        '//server-rs/pantoken-tar-validate:pantoken_tar_validate_lib[clippy.json]' \
        '//server-rs/pantoken-server:pantoken_server_lib[clippy.json]'

# Build the pantoken-server binary via Buck2 (uses remote cache if .buckconfig.local present).
buck2-build-server:
    bash scripts/buck2/check-version.sh && buck2 build '//server-rs/pantoken-server:pantoken_server'

# Build pantoken-server via Buck2 and print the binary path.
# (Uses remote cache if .buckconfig.local present.)
buck2-server-bin:
    @bash scripts/buck2/check-version.sh && buck2 build --show-output '//server-rs/pantoken-server:pantoken_server' | tail -1 | awk '{print $$2}'

# Run all server-rs Rust tests via Buck2 (13 targets — all build and test
# after Issue #119 resolved the OpenSSL/ring compilation blocker).
buck2-test:
    bash scripts/buck2/check-version.sh && buck2 test '//server-rs/pantoken-protocol:fold_corpus_tests' '//server-rs/pantoken-daemon-types:target_version_test' '//server-rs/pantoken-daemon-types:daemon_types_roundtrip' '//server-rs/pantoken-daemon-types:schema_inventory_test' '//server-rs/pantoken-remote-layout:unit_tests' '//server-rs/pantoken-tar-validate:unit_tests' '//server-rs/pantoken-server:server_lib_unit_tests' '//server-rs/pantoken-server:corpus_tests' '//server-rs/pantoken-server:live_path_tests' '//server-rs/pantoken-server:websocket_adapter_tests' '//server-rs/pantoken-server:stdio_adapter_tests' '//server-rs/pantoken-server:resume_and_recovery_tests' '//server-rs/pantoken-server:remote_runtime_tests'

# Build the unsigned headless archive via Buck2 (uses remote cache if .buckconfig.local present).
buck2-archive:
    bash scripts/buck2/check-version.sh && buck2 build '//:pantoken_headless_unsigned'

# Validate the unsigned headless archive via Buck2 (uses remote cache if .buckconfig.local present).
buck2-validate-archive:
    bash scripts/buck2/check-version.sh && buck2 test '//:validate_headless_archive'

# --- Buck2 remote cache (auto-read from .buckconfig.local) ---
# Buck2 auto-reads .buckconfig.local (gitignored, contains Tailscale address),
# so all buck2 commands use the remote cache when available and fall back to
# local execution when the cache is unreachable. Requires
# BUCK2_TEST_FORCE_CACHE_UPLOAD=true in the environment (set in .envrc) for
# cache uploads to work.
# See .buckconfig.local.example and docs/remote-cache-setup.md.

# List all Buck2 targets in the server-rs tree.
buck2-targets:
    bash scripts/buck2/check-version.sh && buck2 uquery 'kind(rust_library, //server-rs/...) + kind(rust_binary, //server-rs/...) + kind(rust_test, //server-rs/...)'

# Regenerate Reindeer third-party dependencies (requires network).
buck2-deps-regenerate:
    bash scripts/buck2/check-version.sh && scripts/buck2/run-reindeer.sh vendor && scripts/buck2/run-reindeer.sh buckify

# Check that Reindeer regeneration produces no diff (vendor sources + BUCK).
buck2-deps-check:
    bash scripts/buck2/check-version.sh && scripts/buck2/run-reindeer.sh vendor && scripts/buck2/run-reindeer.sh buckify && test -z "$(jj diff --name-only -- third-party/BUCK third-party/vendor/ third-party/fixups/)"

# Validate that Buck2 targets match the expected-target manifest.
buck2-targets-check:
    bash scripts/buck2/check-version.sh && python3 scripts/buck2/check-targets.py

# Validate test inventory against expected targets.
buck2-test-inventory-check:
    bash scripts/buck2/check-version.sh && python3 scripts/buck2/check-test-inventory.py

# Run the Buck2 POC measurement script.
buck2-measure:
    bash scripts/buck2/measure-poc.sh

# Run bootstrap test harness (tests version-check failure paths).
buck2-check-tests:
    bash buck2/test-bootstrap.sh

# Run the CI-equivalent Buck2 gate (clippy + build + test + archive + validate + manifest checks).
# Requires Buck2 + Reindeer installed (see buck2/bootstrap.sh).
# This mirrors the .github/workflows/ci.yml buck2 job (local-only, no remote cache).
buck2-ci:
    just buck2-clippy
    just buck2-build
    just buck2-build-server
    just buck2-test
    just buck2-archive
    just buck2-validate-archive
    just buck2-targets-check
    just buck2-test-inventory-check
