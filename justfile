# Default recipe — show available commands
default:
    @just --list

# Start the development server (mock driver is recommended for local UI work).
dev *args:
    bun run scripts/dev.ts {{ args }}

# Spawn a polytoken TUI agent to implement a GitHub issue.
# Usage: just implement-issue <issue-url>
# just implement-issue --dry-run <issue-url>  (print commands, don't execute)
implement-issue *args:
    bun run scripts/implement-issue.ts {{ args }}

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

# Build the Rust sidecar used by the desktop app.
build-hub *args:
    bun scripts/desktop/build-hub.ts {{ args }}

# Cut a desktop release. Defaults to a patch release; supports release.ts flags.
release *args:
    bun scripts/desktop/release.ts {{ args }}

# Publish a desktop release and its updater manifest.
publish *args:
    bun scripts/desktop/publish.ts {{ args }}

# Regenerate Rust daemon types after a polytoken daemon bump.
codegen-polytoken-rs:
    bun run scripts/codegen-polytoken-rs.ts

# Capture or recanonicalize the live daemon corpus (spends provider money when capturing).
capture-daemon-corpus *args:
    bun run scripts/capture-daemon-corpus.ts {{ args }}

# Build a headless release artifact.
build-headless *args:
    bun scripts/headless/build.ts {{ args }}

# Validate a headless release archive.
validate-headless-artifact *args:
    bun scripts/headless/validate-artifact.ts {{ args }}

# Smoke-test an extracted headless release payload.
smoke-test-headless *args:
    bun scripts/headless/smoke-test.ts {{ args }}

# Merge release metadata files.
merge-release-metadata *args:
    bun scripts/headless/merge-metadata.ts {{ args }}

# Create all Docker daemon fixtures.
docker-fixtures-setup:
    bash scripts/docker-fixtures/setup-all.sh

# Tear down all Docker daemon fixtures.
docker-fixtures-teardown:
    bash scripts/docker-fixtures/teardown-all.sh
