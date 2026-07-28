#!/usr/bin/env bash
# Buck2 version check and bootstrap preflight.
#
# Verifies that the installed Buck2 binary matches the pinned revision
# and that the Rust toolchain is the correct version.
#
# Usage: scripts/buck2/check-version.sh [--binary <path>]
#   --binary <path>  Override the Buck2 binary path (default: $BUCK2 or `which buck2`)
#
# Exit codes:
#   0 — all checks pass
#   1 — Buck2 binary not found
#   2 — Buck2 version/revision mismatch
#   3 — Rust toolchain mismatch
#   4 — Malformed Buck2 binary
#
# Pinned revisions:
#   Buck2: 2026-07-14-1560aca2002865cd73d7cafb22c705cfb640b2bc
#   Reindeer: efe17c7bb0b547ed07d48111ebcbeea5fa42a904
#   Rust: 1.97.1 (aarch64-apple-darwin)
#
# CI bootstrap: download the prebuilt binary from GitHub releases at
# https://github.com/facebook/buck2/releases matching the pinned revision.
# Reindeer releases: https://github.com/facebookincubator/reindeer/releases
#   Closest release tag to the pinned commit: v2026.07.27.00
#   Download reindeer-aarch64-apple-darwin.zst for macOS arm64.
# NOTE: Checksum verification and controlled-cache installation are not yet
# implemented in this POC. The current check verifies binary presence and
# version only. See docs/buck2-poc-findings.md for the bootstrap gap.

set -euo pipefail

# ── Pinned versions ────────────────────────────────────────────────────────

ACCEPTED_BUCK2_REVISION="1560aca2002865cd73d7cafb22c705cfb640b2bc"
ACCEPTED_BUCK2_DATE="2026-07-14"
ACCEPTED_RUSTC_VERSION="rustc 1.97.1"
ACCEPTED_HOST_TRIPLE="aarch64-apple-darwin"
ACCEPTED_REINDEER_COMMIT="efe17c7bb0b547ed07d48111ebcbeea5fa42a904"
REINDEER_REPO="https://github.com/facebookincubator/reindeer"

# ── Parse arguments ─────────────────────────────────────────────────────────

BUCK2_BIN="${BUCK2:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)
      BUCK2_BIN="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--binary <path>]" >&2
      exit 1
      ;;
  esac
done

# If no override, try PATH
if [[ -z "$BUCK2_BIN" ]]; then
  if BUCK2_BIN=$(command -v buck2 2>/dev/null); then
    : # found on PATH
  else
    echo "ERROR: buck2 not found on PATH." >&2
    echo "Install buck2 or set BUCK2=/path/to/buck2 or use --binary <path>." >&2
    echo "Download from https://github.com/facebook/buck2/releases" >&2
    echo "Pinned revision: ${ACCEPTED_BUCK2_DATE}-${ACCEPTED_BUCK2_REVISION}" >&2
    exit 1
  fi
fi

# ── Check Buck2 binary ──────────────────────────────────────────────────────

if [[ ! -x "$BUCK2_BIN" ]]; then
  echo "ERROR: Buck2 binary not executable or not found: $BUCK2_BIN" >&2
  exit 1
fi

BUCK2_OUTPUT=$("$BUCK2_BIN" --version 2>&1) || {
  echo "ERROR: Buck2 binary is malformed or crashed: $BUCK2_BIN" >&2
  echo "Output: $BUCK2_OUTPUT" >&2
  exit 4
}

# Extract the revision from the version string
# Expected format: buck2 2026-07-14-1560aca2002865cd73d7cafb22c705cfb640b2bc
BUCK2_REVISION=$(echo "$BUCK2_OUTPUT" | grep -oE '[0-9a-f]{40}' || echo "")

if [[ "$BUCK2_REVISION" != "$ACCEPTED_BUCK2_REVISION" ]]; then
  echo "ERROR: Buck2 revision mismatch." >&2
  echo "  Expected: $ACCEPTED_BUCK2_REVISION" >&2
  echo "  Got:      $BUCK2_REVISION" >&2
  echo "  Full version: $BUCK2_OUTPUT" >&2
  echo "Install the pinned revision from https://github.com/facebook/buck2/releases" >&2
  exit 2
fi

echo "OK: Buck2 revision matches ($BUCK2_REVISION)"

# ── Check Rust toolchain ───────────────────────────────────────────────────

RUSTC_BIN="${RUSTC:-rustc}"
if ! RUSTC_OUTPUT=$("$RUSTC_BIN" --version 2>&1); then
  echo "ERROR: rustc not found. Install Rust 1.97.1 via rustup." >&2
  echo "  rustup install 1.97.1" >&2
  exit 3
fi

if [[ "$RUSTC_OUTPUT" != "$ACCEPTED_RUSTC_VERSION"* ]]; then
  echo "ERROR: Rust toolchain mismatch." >&2
  echo "  Expected: $ACCEPTED_RUSTC_VERSION" >&2
  echo "  Got:      $RUSTC_OUTPUT" >&2
  echo "  Install via: rustup install 1.97.1" >&2
  exit 3
fi

# Check host triple
RUSTC_VERBOSE=$("$RUSTC_BIN" --version --verbose 2>&1)
HOST_TRIPLE=$(echo "$RUSTC_VERBOSE" | grep "^host:" | awk '{print $2}')

if [[ "$HOST_TRIPLE" != "$ACCEPTED_HOST_TRIPLE" ]]; then
  echo "ERROR: Host triple is $HOST_TRIPLE, expected $ACCEPTED_HOST_TRIPLE" >&2
  echo "  Buck2 POC is tested only on $ACCEPTED_HOST_TRIPLE." >&2
  echo "  x86_64-unknown-linux-gnu is explicitly excluded from Buck2 targets." >&2
  exit 3
fi

echo "OK: Rust toolchain matches ($RUSTC_OUTPUT)"

# ── Check Reindeer (optional, only for dependency regeneration) ────────────

if REINDEER_BIN=$(command -v reindeer 2>/dev/null); then
  echo "OK: Reindeer found at $REINDEER_BIN"
  echo "  Pinned commit: $ACCEPTED_REINDEER_COMMIT"
  echo "  Repo: $REINDEER_REPO"
  echo "  Install: cargo install --git $REINDEER_REPO --rev $ACCEPTED_REINDEER_COMMIT reindeer"
  echo "  Or download from: https://github.com/facebookincubator/reindeer/releases"
  echo "  (closest release tag: v2026.07.27.00)"
else
  echo "INFO: Reindeer not installed (only needed for dependency regeneration)." >&2
  echo "  Install: cargo install --git $REINDEER_REPO --rev $ACCEPTED_REINDEER_COMMIT reindeer" >&2
fi

echo ""
echo "All preflight checks passed."
