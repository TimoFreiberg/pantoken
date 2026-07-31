#!/usr/bin/env bash
# Stages the headless payload into a directory for deterministic archive assembly.
# This script runs inside a Buck2 genrule sandbox.
#
# It copies the server binary and metadata files into a flat staging directory
# matching the release artifact layout:
#   VERSION, BUILD_SHA, bin/pantoken-server
#
# All paths are relative to the staging directory — no checkout-root,
# HOME, temp, or absolute paths appear in output bytes.

set -euo pipefail

STAGING="$1"
mkdir -p "$STAGING/bin"

# ── Binary (mode 0755) ──────────────────────────────────────────────────────
cp "$PANTOKEN_SERVER_BIN" "$STAGING/bin/pantoken-server"
chmod 0755 "$STAGING/bin/pantoken-server"

# ── VERSION + BUILD_SHA ─────────────────────────────────────────────────────
# Use the genrule-produced files if available, otherwise fall back to defaults.
if [[ -n "${VERSION_FILE:-}" && -f "$VERSION_FILE" ]]; then
    cp "$VERSION_FILE" "$STAGING/VERSION"
else
    echo '0.0.0' > "$STAGING/VERSION"
fi
if [[ -n "${BUILD_SHA_FILE:-}" && -f "$BUILD_SHA_FILE" ]]; then
    cp "$BUILD_SHA_FILE" "$STAGING/BUILD_SHA"
else
    echo '0000000000000000000000000000000000000000' > "$STAGING/BUILD_SHA"
fi

echo "Staged $(find "$STAGING" -type f | wc -l | tr -d ' ') files" >&2
