#!/usr/bin/env bash
# Stages the headless payload into a directory for deterministic archive assembly.
# This script runs inside a Buck2 genrule sandbox.
#
# It copies binaries, deploy scripts, client-dist, and metadata files into
# a flat staging directory matching the release artifact layout:
#   VERSION, BUILD_SHA, bin/pantoken-server, bin/pantoken-tar-validate,
#   run.sh, update.sh, client-dist/index.html, client-dist/assets/*
#
# All paths are relative to the staging directory — no checkout-root,
# HOME, temp, or absolute paths appear in output bytes.

set -euo pipefail

STAGING="$1"
mkdir -p "$STAGING/bin" "$STAGING/client-dist"

# ── Binaries (mode 0755) ────────────────────────────────────────────────────
cp "$PANTOKEN_SERVER_BIN" "$STAGING/bin/pantoken-server"
chmod 0755 "$STAGING/bin/pantoken-server"

cp "$PANTOKEN_TAR_VALIDATE_BIN" "$STAGING/bin/pantoken-tar-validate"
chmod 0755 "$STAGING/bin/pantoken-tar-validate"

# ── Deploy scripts (mode 0755, update-headless.sh → update.sh) ──────────────
cp "$RUN_SH" "$STAGING/run.sh"
chmod 0755 "$STAGING/run.sh"

cp "$UPDATE_HEADLESS_SH" "$STAGING/update.sh"
chmod 0755 "$STAGING/update.sh"

# ── VERSION + BUILD_SHA ─────────────────────────────────────────────────────
echo '0.0.0-dev' > "$STAGING/VERSION"
echo '0000000000000000000000000000000000000000' > "$STAGING/BUILD_SHA"

# ── Client-dist files ───────────────────────────────────────────────────────
# Copy only the allowlisted PWA root files (mirrors the Bazel filegroup glob).
if [ -d "$CLIENT_DIST_DIR" ]; then
    # index.html
    [ -f "$CLIENT_DIST_DIR/index.html" ] && cp "$CLIENT_DIST_DIR/index.html" "$STAGING/client-dist/"
    # assets/
    if [ -d "$CLIENT_DIST_DIR/assets" ]; then
        mkdir -p "$STAGING/client-dist/assets"
        cp -R "$CLIENT_DIST_DIR/assets/"* "$STAGING/client-dist/assets/" 2>/dev/null || true
    fi
    # PWA root files
    for pattern in apple-touch-icon* icon* favicon* manifest* sw* registerSW*; do
        for f in "$CLIENT_DIST_DIR"/$pattern; do
            [ -f "$f" ] && cp "$f" "$STAGING/client-dist/"
        done
    done
fi

echo "Staged $(find "$STAGING" -type f | wc -l | tr -d ' ') files" >&2
