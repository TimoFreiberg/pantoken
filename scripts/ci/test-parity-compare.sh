#!/usr/bin/env bash
# scripts/ci/test-parity-compare.sh — Unit test for buck2-parity-compare.sh.
#
# Creates two archives with known content (one matching, one differing) and
# asserts that the parity comparison script exits 0 on match and 1 on mismatch.
#
# Usage: bash scripts/ci/test-parity-compare.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPARE_SCRIPT="$SCRIPT_DIR/buck2-parity-compare.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# ── Create a base archive directory structure ────────────────────────────────
create_archive_content() {
  local dir="$1"
  local version="${2:-1.0.0}"
  local sha="${3:-abcdef1234567890abcdef1234567890abcdef12}"

  mkdir -p "$dir/bin"
  echo "$version" > "$dir/VERSION"
  echo "$sha" > "$dir/BUILD_SHA"
  echo "#!/bin/sh" > "$dir/bin/pantoken-server"
  chmod 0755 "$dir/bin/pantoken-server"
}

make_archive() {
  local src_dir="$1"
  local dest="$2"
  COPYFILE_DISABLE=1 tar -czf "$dest" -C "$src_dir" .
}

PASS=0
FAIL=0

echo "=== Test 1: Matching archives → exit 0 ==="
create_archive_content "$TMPDIR/match-a" "1.0.0" "abcdef1234567890abcdef1234567890abcdef12"
create_archive_content "$TMPDIR/match-b" "1.0.0" "abcdef1234567890abcdef1234567890abcdef12"
make_archive "$TMPDIR/match-a" "$TMPDIR/archive-a.tar.gz"
make_archive "$TMPDIR/match-b" "$TMPDIR/archive-b.tar.gz"

if bash "$COMPARE_SCRIPT" "$TMPDIR/archive-a.tar.gz" "$TMPDIR/archive-b.tar.gz" >/dev/null 2>&1; then
  echo "  PASS: matching archives exit 0"
  PASS=$((PASS + 1))
else
  echo "  FAIL: matching archives did not exit 0" >&2
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Test 2: Differing VERSION → exit 1 ==="
create_archive_content "$TMPDIR/diff-ver-a" "1.0.0" "abcdef1234567890abcdef1234567890abcdef12"
create_archive_content "$TMPDIR/diff-ver-b" "2.0.0" "abcdef1234567890abcdef1234567890abcdef12"
make_archive "$TMPDIR/diff-ver-a" "$TMPDIR/diff-ver-a.tar.gz"
make_archive "$TMPDIR/diff-ver-b" "$TMPDIR/diff-ver-b.tar.gz"

if ! bash "$COMPARE_SCRIPT" "$TMPDIR/diff-ver-a.tar.gz" "$TMPDIR/diff-ver-b.tar.gz" >/dev/null 2>&1; then
  echo "  PASS: differing VERSION exits 1"
  PASS=$((PASS + 1))
else
  echo "  FAIL: differing VERSION did not exit 1" >&2
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Test 3: Differing BUILD_SHA → exit 1 ==="
create_archive_content "$TMPDIR/diff-sha-a" "1.0.0" "abcdef1234567890abcdef1234567890abcdef12"
create_archive_content "$TMPDIR/diff-sha-b" "1.0.0" "0000000000000000000000000000000000000000"
make_archive "$TMPDIR/diff-sha-a" "$TMPDIR/diff-sha-a.tar.gz"
make_archive "$TMPDIR/diff-sha-b" "$TMPDIR/diff-sha-b.tar.gz"

if ! bash "$COMPARE_SCRIPT" "$TMPDIR/diff-sha-a.tar.gz" "$TMPDIR/diff-sha-b.tar.gz" >/dev/null 2>&1; then
  echo "  PASS: differing BUILD_SHA exits 1"
  PASS=$((PASS + 1))
else
  echo "  FAIL: differing BUILD_SHA did not exit 1" >&2
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Test 4: Missing file → exit 1 ==="
create_archive_content "$TMPDIR/missing-a" "1.0.0" "abcdef1234567890abcdef1234567890abcdef12"
create_archive_content "$TMPDIR/missing-b" "1.0.0" "abcdef1234567890abcdef1234567890abcdef12"
rm "$TMPDIR/missing-b/bin/pantoken-server"
make_archive "$TMPDIR/missing-a" "$TMPDIR/missing-a.tar.gz"
make_archive "$TMPDIR/missing-b" "$TMPDIR/missing-b.tar.gz"

if ! bash "$COMPARE_SCRIPT" "$TMPDIR/missing-a.tar.gz" "$TMPDIR/missing-b.tar.gz" >/dev/null 2>&1; then
  echo "  PASS: missing file exits 1"
  PASS=$((PASS + 1))
else
  echo "  FAIL: missing file did not exit 1" >&2
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Test 5: Differing permissions → exit 1 ==="
create_archive_content "$TMPDIR/perm-a" "1.0.0" "abcdef1234567890abcdef1234567890abcdef12"
create_archive_content "$TMPDIR/perm-b" "1.0.0" "abcdef1234567890abcdef1234567890abcdef12"
chmod 0644 "$TMPDIR/perm-b/bin/pantoken-server"
make_archive "$TMPDIR/perm-a" "$TMPDIR/perm-a.tar.gz"
make_archive "$TMPDIR/perm-b" "$TMPDIR/perm-b.tar.gz"

if ! bash "$COMPARE_SCRIPT" "$TMPDIR/perm-a.tar.gz" "$TMPDIR/perm-b.tar.gz" >/dev/null 2>&1; then
  echo "  PASS: differing permissions exits 1"
  PASS=$((PASS + 1))
else
  echo "  FAIL: differing permissions did not exit 1" >&2
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Summary: $PASS passed, $FAIL failed ==="
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
