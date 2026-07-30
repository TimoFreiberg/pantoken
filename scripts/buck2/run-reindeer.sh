#!/usr/bin/env bash
# Wrapper for Reindeer that sets the absolute manifest_path dynamically.
# Usage: scripts/buck2/run-reindeer.sh <vendor|buckify>
#
# Reindeer requires an absolute manifest_path, but we don't want to hardcode
# a checkout-specific path in reindeer.toml. This wrapper sets it via CLI flag.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MANIFEST_PATH="$REPO_ROOT/third-party/Cargo.toml"

export PATH="$HOME/.cargo/bin:$PATH"

case "${1:-}" in
  vendor)
    # Downloads all crates to third-party/vendor/ (gitignored) and creates
    # third-party/.cargo/config.toml redirecting crates.io to vendor/.
    # Use for offline development; NOT needed for buckify (which generates
    # http_archive rules when vendor/ is absent).
    reindeer --manifest-path "$MANIFEST_PATH" vendor "${@:2}"
    ;;
  buckify)
    # Ensure .cargo/config.toml (created by `vendor`) doesn't redirect
    # crates.io to a stale or absent vendor/ directory. Without this,
    # cargo metadata fails or buckify produces vendor-path rules instead
    # of http_archive rules.
    if [ -f "$REPO_ROOT/third-party/.cargo/config.toml" ]; then
      rm -f "$REPO_ROOT/third-party/.cargo/config.toml"
    fi
    reindeer --manifest-path "$MANIFEST_PATH" buckify "${@:2}"
    ;;
  *)
    echo "Usage: $0 <vendor|buckify> [extra args]" >&2
    exit 1
    ;;
esac
