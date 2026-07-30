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

# ── Client-dist files ───────────────────────────────────────────────────────
# $(location :client_dist) resolves to a directory containing the filegroup's
# files at their project-relative paths (e.g. .../client_dist/client/dist/).
# Find the client/dist subdirectory and copy from there.
if [ -d "$CLIENT_DIST_DIR" ]; then
    DIST_DIR="$CLIENT_DIST_DIR"
elif [ -f "$CLIENT_DIST_DIR" ]; then
    DIST_DIR="$(dirname "$CLIENT_DIST_DIR")"
else
    echo "ERROR: CLIENT_DIST_DIR does not exist: $CLIENT_DIST_DIR" >&2
    exit 1
fi
# Source filegroups preserve project-relative paths, so the dist files are
# nested under client/dist/ within the materialized directory. Walk down.
CLIENT_ROOT=""
for candidate in "$DIST_DIR" "$DIST_DIR/client/dist" "$DIST_DIR/client_dist/client/dist"; do
    if [ -f "$candidate/index.html" ]; then
        CLIENT_ROOT="$candidate"
        break
    fi
done
if [ -z "$CLIENT_ROOT" ]; then
    echo "ERROR: could not find index.html under $DIST_DIR" >&2
    find "$DIST_DIR" -name 'index.html' >&2 || true
    exit 1
fi
# index.html
cp "$CLIENT_ROOT/index.html" "$STAGING/client-dist/"
# assets/
if [ -d "$CLIENT_ROOT/assets" ]; then
    mkdir -p "$STAGING/client-dist/assets"
    cp -R "$CLIENT_ROOT/assets/"* "$STAGING/client-dist/assets/" 2>/dev/null || echo "WARN: no assets to copy" >&2
fi
# PWA root files
for pattern in apple-touch-icon* icon* favicon* manifest* sw* registerSW*; do
    for f in "$CLIENT_ROOT"/$pattern; do
        [ -f "$f" ] && cp "$f" "$STAGING/client-dist/"
    done
done

echo "Staged $(find "$STAGING" -type f | wc -l | tr -d ' ') files" >&2
