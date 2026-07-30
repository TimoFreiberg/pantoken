#!/usr/bin/env bash
# buck2/bootstrap.sh — Buck2 + Reindeer + Rust toolchain preflight.
#
# Validates that the exact pinned Buck2, Reindeer, and Rust toolchain are
# present and correct before any Buck2 graph command. Exits 0 on success,
# 1 on any mismatch with a deterministic stderr message.
#
# Usage:
#   buck2/bootstrap.sh                    # check all (buck2 + reindeer + rust)
#   buck2/bootstrap.sh --binary /path      # override buck2 binary
#   BUCK2=/path buck2/bootstrap.sh         # override via env
#
# Exit codes:
#   0 — all checks pass
#   1 — buck2 not found / wrong version / malformed binary
#   2 — reindeer not found / wrong version
#   3 — rust toolchain mismatch
set -euo pipefail

# ─── Pinned versions ────────────────────────────────────────────────────────
# These values are the accepted revisions for this POC. The manually installed
# binary at /Users/timo/.local/bin/buck2 is an environment-specific smoke
# check; CI must use the bootstrap path documented in docs/buck2-poc.md.

BUCK2_ACCEPTED_REVISION="1560aca2002865cd73d7cafb22c705cfb640b2bc"
BUCK2_ACCEPTED_DATE="2026-07-14"
BUCK2_ACCEPTED_VERSION_STRING="buck2 ${BUCK2_ACCEPTED_DATE}-${BUCK2_ACCEPTED_REVISION}"

REINDEER_ACCEPTED_COMMIT="efe17c7bb0b547ed07d48111ebcbeea5fa42a904"
REINDEER_REPO_URL="https://github.com/facebookincubator/reindeer"

RUST_ACCEPTED_VERSION="1.97.1"
RUST_ACCEPTED_HOST="${BUCK2_EXPECTED_HOST_TRIPLE:-aarch64-apple-darwin}"

# The operator's manually-installed binary; treated as environment-specific.
BUCK2_DEFAULT="/Users/timo/.local/bin/buck2"

# Script directory (repo-root/buck2)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Helpers ────────────────────────────────────────────────────────────────
fail() {
    echo "buck2-bootstrap: $*" >&2
    exit "${2:-1}"
}

# ─── Parse args ─────────────────────────────────────────────────────────────
BUCK2_BIN=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --binary)
            BUCK2_BIN="$2"
            shift 2
            ;;
        --binary=*)
            BUCK2_BIN="${1#*=}"
            shift
            ;;
        *)
            fail "unknown argument: $1" 1
            ;;
    esac
done

# Env override takes precedence over default, but --binary takes precedence over both
if [[ -z "$BUCK2_BIN" ]]; then
    BUCK2_BIN="${BUCK2:-$BUCK2_DEFAULT}"
fi

# ─── Buck2 check ────────────────────────────────────────────────────────────
check_buck2() {
    if [[ ! -x "$BUCK2_BIN" ]]; then
        fail "buck2 not found at '$BUCK2_BIN'. Install via 'cargo install --git https://github.com/facebook/buck2 --rev ${BUCK2_ACCEPTED_REVISION} buck2' or set BUCK2 env var / --binary flag." 1
    fi

    local version_output
    version_output="$("$BUCK2_BIN" --version 2>&1)" || {
        fail "buck2 binary at '$BUCK2_BIN' is malformed or failed to execute (exit $?)." 1
    }

    # Expected format: "buck2 2026-07-14-1560aca2002865cd73d7cafb22c705cfb640b2bc"
    local extracted_rev
    extracted_rev="$(echo "$version_output" | grep -oE '[0-9a-f]{40}' | head -1)"

    if [[ -z "$extracted_rev" ]]; then
        fail "buck2 version output is malformed: '$version_output'. Expected format: '${BUCK2_ACCEPTED_VERSION_STRING}'." 1
    fi

    if [[ "$extracted_rev" != "$BUCK2_ACCEPTED_REVISION" ]]; then
        fail "buck2 revision mismatch: got '$extracted_rev', expected '$BUCK2_ACCEPTED_REVISION'. Reinstall the pinned version." 1
    fi

    echo "buck2-bootstrap: buck2 OK ($version_output)"
}

# ─── Reindeer check ─────────────────────────────────────────────────────────
check_reindeer() {
    # Reindeer is only needed for dependency regeneration, not normal builds.
    # The binary is expected on PATH. Normal Buck2 builds do not invoke Reindeer.
    # NOTE: This check only verifies presence, not the exact pinned commit.
    # Reindeer has no --version flag. To verify the pinned commit, install from:
    #   cargo install --git https://github.com/facebookincubator/reindeer --rev efe17c7bb0b547ed07d48111ebcbeea5fa42a904 reindeer
    # Or download from https://github.com/facebookincubator/reindeer/releases
    # (closest release tag: v2026.07.27.00)
    local reindeer_bin=""
    if command -v reindeer &>/dev/null; then
        reindeer_bin="$(command -v reindeer)"
    else
        # Not a hard failure for build/test — only for deps regeneration.
        echo "buck2-bootstrap: reindeer not found (only needed for 'just buck2-deps-regenerate')" >&2
        echo "  Install: cargo install --git $REINDEER_REPO_URL --rev $REINDEER_ACCEPTED_COMMIT reindeer" >&2
        return 0
    fi
    echo "buck2-bootstrap: reindeer found at $reindeer_bin"
    echo "  Pinned commit: $REINDEER_ACCEPTED_COMMIT (not verified — presence-only check)"
}

# ─── Rust toolchain check ───────────────────────────────────────────────────
check_rust() {
    local rustc_bin
    rustc_bin="$(command -v rustc 2>/dev/null || true)"
    if [[ -z "$rustc_bin" ]]; then
        # Try ~/.cargo/bin
        if [[ -x "$HOME/.cargo/bin/rustc" ]]; then
            rustc_bin="$HOME/.cargo/bin/rustc"
        else
            fail "rustc not found on PATH or ~/.cargo/bin. Install Rust $RUST_ACCEPTED_VERSION via rustup." 3
        fi
    fi

    local version_output
    version_output="$("$rustc_bin" --version --verbose 2>&1)"

    local rust_version host_triple
    rust_version="$(echo "$version_output" | grep '^release:' | awk '{print $2}')"
    host_triple="$(echo "$version_output" | grep '^host:' | awk '{print $2}')"

    if [[ "$rust_version" != "$RUST_ACCEPTED_VERSION" ]]; then
        fail "rustc version mismatch: got '$rust_version', expected '$RUST_ACCEPTED_VERSION'. Use rust-toolchain.toml (channel $RUST_ACCEPTED_VERSION)." 3
    fi

    if [[ "$host_triple" != "$RUST_ACCEPTED_HOST" ]]; then
        # If the env override is set, require an exact match. Otherwise, check
        # against the set of supported triples.
        if [[ -z "${BUCK2_EXPECTED_HOST_TRIPLE:-}" ]]; then
            case "$host_triple" in
                aarch64-apple-darwin|x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu)
                    : # supported
                    ;;
                *)
                    fail "rustc host triple is '$host_triple', which is not in the supported set: aarch64-apple-darwin, x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu. Override with BUCK2_EXPECTED_HOST_TRIPLE." 3
                    ;;
            esac
        else
            fail "rustc host triple mismatch: got '$host_triple', expected '$RUST_ACCEPTED_HOST' (set via BUCK2_EXPECTED_HOST_TRIPLE)." 3
        fi
    fi

    echo "buck2-bootstrap: rust OK ($rust_version, host=$host_triple, binary=$rustc_bin)"
}

# ─── Run all checks ─────────────────────────────────────────────────────────
check_buck2
check_reindeer
check_rust
echo "buck2-bootstrap: all preflight checks passed"
