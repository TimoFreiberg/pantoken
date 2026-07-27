#!/usr/bin/env bash
# Validates the Bazel-assembled unsigned headless archive using the Bazel-built
# pantoken-tar-validate binary. Exit 0 = valid (archive safety + schema match).
set -uo pipefail

VALIDATOR="$1"
ARCHIVE="$2"

echo "Validating archive: $ARCHIVE"
echo "Using validator: $VALIDATOR"

# Show the archive members for debugging.
echo "--- Archive members ---"
tar tzf "$ARCHIVE"
echo "---"

# Run the Rust validator — exit 0 = valid, 2 = malformed, 3 = unsafe.
# Note: we don't use `set -e` so we can capture the exit code and print a summary.
"$VALIDATOR" "$ARCHIVE"
result=$?

if [ "$result" -eq 0 ]; then
    echo "✓ Archive is valid"
    exit 0
else
    echo "✗ Archive validation failed (exit $result)"
    exit "$result"
fi
