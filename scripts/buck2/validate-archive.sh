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

# Run the validator. It exits 0 on success, non-zero on validation failure.
"$VALIDATOR" "$ARCHIVE"

echo "Archive validation passed: $ARCHIVE" >&2
