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
    # The ece RustCrypto fork is a path dependency in third-party/Cargo.toml's
    # [patch.crates-io]. Reindeer's vendor step runs `cargo metadata` which
    # requires the path dep to exist, but a previous vendor run may have
    # deleted it (reindeer doesn't manage path deps). Restore it from VCS
    # before vendoring.
    if [ ! -f "$REPO_ROOT/third-party/vendor/ece-2.3.1-rustcrypto/Cargo.toml" ]; then
      echo "run-reindeer.sh: restoring ece-2.3.1-rustcrypto from VCS before vendor" >&2
      (cd "$REPO_ROOT" && jj restore third-party/vendor/ece-2.3.1-rustcrypto) 2>/dev/null || \
      (cd "$REPO_ROOT" && git checkout -- third-party/vendor/ece-2.3.1-rustcrypto) 2>/dev/null || \
      echo "run-reindeer.sh: WARNING — could not restore ece-2.3.1-rustcrypto; vendor will fail" >&2
    fi
    reindeer --manifest-path "$MANIFEST_PATH" vendor "${@:2}"
    # vendor may delete the ece fork again (it doesn't manage path deps).
    # Restore it so buckify can resolve `cargo metadata`.
    if [ ! -f "$REPO_ROOT/third-party/vendor/ece-2.3.1-rustcrypto/Cargo.toml" ]; then
      echo "run-reindeer.sh: restoring ece-2.3.1-rustcrypto from VCS after vendor" >&2
      (cd "$REPO_ROOT" && jj restore third-party/vendor/ece-2.3.1-rustcrypto) 2>/dev/null || \
      (cd "$REPO_ROOT" && git checkout -- third-party/vendor/ece-2.3.1-rustcrypto) 2>/dev/null || \
      echo "run-reindeer.sh: WARNING — could not restore ece-2.3.1-rustcrypto; buckify will fail" >&2
    fi
    ;;
  buckify)
    reindeer --manifest-path "$MANIFEST_PATH" buckify "${@:2}"
    ;;
  *)
    echo "Usage: $0 <vendor|buckify> [extra args]" >&2
    exit 1
    ;;
esac
