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
    tsx scripts/dev.ts {{ args }}

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

# Full Rust formatting, clippy, and nextest gate.
check-rs:
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
    tsx scripts/implement-issue.ts {{ args }}

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
    tsx scripts/desktop/build-hub.ts {{ args }}

# Regenerate Rust daemon types after a polytoken daemon bump.
codegen-polytoken-rs:
    tsx scripts/codegen-polytoken-rs.ts

# Capture or recanonicalize the live daemon corpus (expensive/provider-dependent).
capture-daemon-corpus *args:
    tsx scripts/capture-daemon-corpus.ts {{ args }}

# Create all Docker daemon fixtures.
docker-fixtures-setup:
    bash scripts/docker-fixtures/setup-all.sh

# Tear down all Docker daemon fixtures.
docker-fixtures-teardown:
    bash scripts/docker-fixtures/teardown-all.sh

# --- Headless artifacts and release (expensive/credential-bearing) ---

# Build a headless release artifact.
build-headless *args:
    tsx scripts/headless/build.ts {{ args }}

# Validate a headless release archive.
validate-headless-artifact *args:
    tsx scripts/headless/validate-artifact.ts {{ args }}

# Smoke-test an extracted headless release payload.
smoke-test-headless *args:
    tsx scripts/headless/smoke-test.ts {{ args }}

# Merge release metadata files.
merge-release-metadata *args:
    tsx scripts/headless/merge-metadata.ts {{ args }}

# Cut a desktop release (credential/signing workflow).
release *args:
    tsx scripts/desktop/release.ts {{ args }}

# Publish a desktop release and its updater manifest (credentials required).
publish *args:
    tsx scripts/desktop/publish.ts {{ args }}
