#!/usr/bin/env bash
# scripts/ci/test-archive-metadata.sh — Test that Buck2 archive genrules
# accept real VERSION/BUILD_SHA values from a CI-generated .buckconfig.ci.
#
# This test verifies the read_config() mechanism:
#   1. Build with a temporary .buckconfig.ci containing custom values.
#      Assert VERSION and BUILD_SHA files contain the expected values.
#   2. Build WITHOUT a config file. Assert defaults (0.0.0 / 000...000).
#
# Prerequisites: buck2 must be installed and on PATH, client/dist must exist.
# Usage: bash scripts/ci/test-archive-metadata.sh

set -euo pipefail

# ── Setup ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

TEST_VERSION="9.9.9"
TEST_BUILD_SHA="testsha00000000000000000000000000000000000"
DEFAULT_VERSION="0.0.0"
DEFAULT_BUILD_SHA="0000000000000000000000000000000000000000"

# Temp directory for extraction
TMPDIR=$(mktemp -d)
# Also clean up .buckconfig.ci if it was left behind by a failed test
trap 'rm -rf "$TMPDIR"; rm -f .buckconfig.ci' EXIT

echo "=== Test 1: Custom VERSION/BUILD_SHA via .buckconfig.ci ==="

# Write the CI config snippet
cat > .buckconfig.ci <<EOF
[pantoken]
version = $TEST_VERSION
build_sha = $TEST_BUILD_SHA
EOF

# Build the archive with the config file
echo "  Building archive with .buckconfig.ci..."
if ! buck2 build --config-file .buckconfig.ci //:pantoken_headless_unsigned 2>&1; then
  echo "FAIL: buck2 build with .buckconfig.ci failed" >&2
  rm -f .buckconfig.ci
  exit 1
fi

# Get the output path
ARCHIVE_PATH=$(buck2 build --config-file .buckconfig.ci --show-output //:pantoken_headless_unsigned 2>/dev/null | tail -1 | awk '{print $2}')
if [[ -z "$ARCHIVE_PATH" || ! -f "$ARCHIVE_PATH" ]]; then
  echo "FAIL: could not locate built archive" >&2
  rm -f .buckconfig.ci
  exit 1
fi

# Extract and check VERSION + BUILD_SHA
EXTRACT_DIR="$TMPDIR/custom"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"

# Check VERSION
ACTUAL_VERSION=$(cat "$EXTRACT_DIR/VERSION" | tr -d '\n')
if [[ "$ACTUAL_VERSION" == "$TEST_VERSION" ]]; then
  echo "  PASS: VERSION = '$ACTUAL_VERSION'"
else
  echo "  FAIL: VERSION expected '$TEST_VERSION', got '$ACTUAL_VERSION'" >&2
  rm -f .buckconfig.ci
  exit 1
fi

# Check BUILD_SHA
ACTUAL_SHA=$(cat "$EXTRACT_DIR/BUILD_SHA" | tr -d '\n')
if [[ "$ACTUAL_SHA" == "$TEST_BUILD_SHA" ]]; then
  echo "  PASS: BUILD_SHA = '$ACTUAL_SHA'"
else
  echo "  FAIL: BUILD_SHA expected '$TEST_BUILD_SHA', got '$ACTUAL_SHA'" >&2
  rm -f .buckconfig.ci
  exit 1
fi

# Cleanup the CI config
rm -f .buckconfig.ci

echo ""
echo "=== Test 2: Default values without config file ==="

echo "  Building archive without .buckconfig.ci..."
if ! buck2 build //:pantoken_headless_unsigned 2>&1; then
  echo "FAIL: buck2 build without config file failed" >&2
  exit 1
fi

ARCHIVE_PATH=$(buck2 build --show-output //:pantoken_headless_unsigned 2>/dev/null | tail -1 | awk '{print $2}')
if [[ -z "$ARCHIVE_PATH" || ! -f "$ARCHIVE_PATH" ]]; then
  echo "FAIL: could not locate built archive" >&2
  exit 1
fi

EXTRACT_DIR="$TMPDIR/default"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"

# Check VERSION default
ACTUAL_VERSION=$(cat "$EXTRACT_DIR/VERSION" | tr -d '\n')
if [[ "$ACTUAL_VERSION" == "$DEFAULT_VERSION" ]]; then
  echo "  PASS: VERSION = '$ACTUAL_VERSION' (default)"
else
  echo "  FAIL: VERSION expected default '$DEFAULT_VERSION', got '$ACTUAL_VERSION'" >&2
  exit 1
fi

# Check BUILD_SHA default
ACTUAL_SHA=$(cat "$EXTRACT_DIR/BUILD_SHA" | tr -d '\n')
if [[ "$ACTUAL_SHA" == "$DEFAULT_BUILD_SHA" ]]; then
  echo "  PASS: BUILD_SHA = '$ACTUAL_SHA' (default)"
else
  echo "  FAIL: BUILD_SHA expected default '$DEFAULT_BUILD_SHA', got '$ACTUAL_SHA'" >&2
  exit 1
fi

echo ""
echo "=== All archive metadata tests passed ==="
