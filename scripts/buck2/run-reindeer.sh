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
    reindeer --manifest-path "$MANIFEST_PATH" vendor "${@:2}"
    ;;
  buckify)
    reindeer --manifest-path "$MANIFEST_PATH" buckify "${@:2}"
    ;;
  *)
    echo "Usage: $0 <vendor|buckify> [extra args]" >&2
    exit 1
    ;;
esac
