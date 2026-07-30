#!/usr/bin/env bash
# Validates a headless archive using the Buck2-built pantoken-tar-validate binary.
# This script runs as a Buck2 sh_test.
#
# Arguments:
#   $1 — path to the pantoken-tar-validate binary (Buck2-built)
#   $2 — path to the archive to validate
#
# HOME and PANTOKEN_TAR_VALIDATOR are explicitly unset in the BUCK env so
# no ambient host state can influence the result.

set -euo pipefail

VALIDATOR="$1"
ARCHIVE="$2"

if [ -z "$VALIDATOR" ] || [ -z "$ARCHIVE" ]; then
    echo "Usage: $0 <validator-binary> <archive>" >&2
    exit 1
fi

if [ ! -f "$VALIDATOR" ]; then
    echo "Error: validator binary not found: $VALIDATOR" >&2
    exit 1
fi

if [ ! -f "$ARCHIVE" ]; then
    echo "Error: archive not found: $ARCHIVE" >&2
    exit 1
fi

# Run the safety validator. It exits 0 on success, non-zero on validation failure.
"$VALIDATOR" "$ARCHIVE"

echo "Safety validation passed: $ARCHIVE" >&2

# ── Content validation ───────────────────────────────────────────────────────
# Based on the content checks in scripts/headless/validate-artifact.ts:
# gzip magic bytes, VERSION format, BUILD_SHA format, and executable
# permissions. The reference validator checks 2 executables (bin/pantoken-server
# and run.sh); this script checks all 4 staged executables since
# stage-payload.sh sets 0755 on all of them. Runs only after the safety
# validator passes.

# Check gzip magic bytes (0x1f 0x8b).
magic=$(head -c 2 "$ARCHIVE" | od -An -tx1 | tr -d ' ')
if [ "$magic" != "1f8b" ]; then
    echo "Error: invalid gzip magic bytes: $magic (expected 1f8b)" >&2
    exit 1
fi
echo "Gzip magic bytes: OK" >&2

# Extract to a temp directory for content inspection.
# Use a local variable (not TMPDIR) to avoid clobbering the Buck2 sandbox env.
EXTRACT_DIR=$(mktemp -d)
trap 'rm -rf "$EXTRACT_DIR"' EXIT

tar xzf "$ARCHIVE" -C "$EXTRACT_DIR"

# Check VERSION format: ^\d+\.\d+\.\d+$
if [ ! -f "$EXTRACT_DIR/VERSION" ]; then
    echo "Error: VERSION file not found in archive" >&2
    exit 1
fi
version=$(tr -d '\n ' < "$EXTRACT_DIR/VERSION")
if ! echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "Error: invalid VERSION format: '$version' (expected ^[0-9]+\\.[0-9]+\\.[0-9]+\$)" >&2
    exit 1
fi
echo "VERSION format: OK ($version)" >&2

# Check BUILD_SHA format: ^[0-9a-f]{40}$
if [ ! -f "$EXTRACT_DIR/BUILD_SHA" ]; then
    echo "Error: BUILD_SHA file not found in archive" >&2
    exit 1
fi
build_sha=$(tr -d '\n ' < "$EXTRACT_DIR/BUILD_SHA")
if ! echo "$build_sha" | grep -qE '^[0-9a-f]{40}$'; then
    echo "Error: invalid BUILD_SHA format: '$build_sha' (expected 40-char lowercase hex)" >&2
    exit 1
fi
echo "BUILD_SHA format: OK" >&2

# Check executable permissions on all 4 staged executables.
# stage-payload.sh sets 0755 on all of them. Uses the portable -x test.
for exec_path in bin/pantoken-server bin/pantoken-tar-validate run.sh update.sh; do
    full_path="$EXTRACT_DIR/$exec_path"
    if [ ! -f "$full_path" ]; then
        echo "Error: $exec_path not found in archive" >&2
        exit 1
    fi
    # stat -f '%Lp' on macOS, stat -c '%a' on Linux — for diagnostic output only.
    mode=$(stat -f '%Lp' "$full_path" 2>/dev/null || stat -c '%a' "$full_path" 2>/dev/null)
    if [ -z "$mode" ]; then
        echo "Error: could not stat $exec_path" >&2
        exit 1
    fi
    # Check if any execute bit is set using the portable -x test.
    if [ ! -x "$full_path" ]; then
        printf 'Error: %s is not executable (mode: %s)\n' "$exec_path" "$mode" >&2
        exit 1
    fi
    echo "Executable permission: OK ($exec_path mode $mode)" >&2
done

echo "Content validation passed: $ARCHIVE" >&2
