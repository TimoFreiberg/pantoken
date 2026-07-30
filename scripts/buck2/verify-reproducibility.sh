#!/usr/bin/env bash
# Verifies that the Buck2 headless archive is byte-for-byte deterministic.
#
# Builds the archive twice with a busted cache and compares sha256. If the
# hashes match, the assembler is deterministic (same inputs → same output
# bytes across independent re-runs). This is a manual verification script,
# not a Buck2 sh_test, because it needs to invoke `buck2 build` and bust the
# action cache itself.
#
# Usage:
#   bash scripts/buck2/verify-reproducibility.sh

set -euo pipefail

TARGET="//:pantoken_headless_unsigned"

build_and_hash() {
    # buck2 build --show-output prints "<target> <path>" on stdout.
    # stderr (diagnostics) flows through so build errors are visible.
    # set -e aborts on build failure before we parse the output.
    local build_stdout
    build_stdout=$(buck2 build --show-output "$TARGET")
    local archive_path
    # --show-output prints "<target> <path>" on stdout; the target may have a
    # cell prefix (e.g. "root//:pantoken_headless_unsigned"). Since we build
    # exactly one target, extract the path (second field) from the matching line.
    archive_path=$(echo "$build_stdout" | grep 'pantoken_headless_unsigned' | awk '{print $2}')

    if [ -z "$archive_path" ] || [ ! -f "$archive_path" ]; then
        echo "Error: could not find archive output path from buck2 build" >&2
        echo "Build output: $build_stdout" >&2
        exit 1
    fi

    shasum -a 256 "$archive_path" | awk '{print $1}'
}

echo "Building archive (first pass)..."
hash1=$(build_and_hash)
echo "  sha256: $hash1"

echo "Busting cache (buck2 clean)..."
buck2 clean

echo "Building archive (second pass)..."
hash2=$(build_and_hash)
echo "  sha256: $hash2"

echo ""
if [ "$hash1" = "$hash2" ]; then
    echo "Reproducibility: PASS — both builds produced identical sha256"
    exit 0
else
    echo "Reproducibility: FAIL — builds produced different sha256"
    echo "  first:  $hash1"
    echo "  second: $hash2"
    exit 1
fi
