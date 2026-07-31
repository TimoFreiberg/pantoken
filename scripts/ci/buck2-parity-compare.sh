#!/usr/bin/env bash
# scripts/ci/buck2-parity-compare.sh — Structural comparison of Buck2-built
# and Cargo-built unsigned headless archives.
#
# The two archives will NOT be byte-identical (Cargo uses BSD tar with host
# timestamps; Buck2 uses a Python assembler with epoch-0 timestamps). This
# script performs a structural comparison:
#   1. File listing (sorted paths) — must match exactly.
#   2. Executable permissions on bin/pantoken-server.
#   3. VERSION file content — must match.
#   4. BUILD_SHA file content — must match.
#   5. Gzip magic bytes — both must be valid gzip.
#   6. Binary sizes within tolerance (should be identical: same source/toolchain).
#
# Usage: bash scripts/ci/buck2-parity-compare.sh <buck2_archive> <cargo_archive>
#
# Exit codes:
#   0 — all checks pass
#   1 — any mismatch

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <buck2_archive> <cargo_archive>" >&2
  exit 1
fi

BUCK2_ARCHIVE="$1"
CARGO_ARCHIVE="$2"

# Files that must have executable mode (0755)
EXEC_FILES=(
  "bin/pantoken-server"
)

# Size tolerance in bytes (allow minor differences from build metadata)
SIZE_TOLERANCE=1024

# ── Helpers ──────────────────────────────────────────────────────────────────
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

BUCK2_DIR="$TMPDIR/buck2"
CARGO_DIR="$TMPDIR/cargo"
mkdir -p "$BUCK2_DIR" "$CARGO_DIR"

PASS=0
FAIL=0

check_pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

check_fail() {
  echo "  FAIL: $1" >&2
  echo "    $2" >&2
  FAIL=$((FAIL + 1))
}

# ── Verify inputs exist ──────────────────────────────────────────────────────
for archive in "$BUCK2_ARCHIVE" "$CARGO_ARCHIVE"; do
  if [[ ! -f "$archive" ]]; then
    echo "ERROR: archive not found: $archive" >&2
    exit 1
  fi
done

echo "=== Parity comparison ==="
echo "  Buck2: $BUCK2_ARCHIVE"
echo "  Cargo: $CARGO_ARCHIVE"
echo ""

# ── Extract both archives ────────────────────────────────────────────────────
tar -xzf "$BUCK2_ARCHIVE" -C "$BUCK2_DIR" || { echo "ERROR: failed to extract Buck2 archive" >&2; exit 1; }
tar -xzf "$CARGO_ARCHIVE" -C "$CARGO_DIR" || { echo "ERROR: failed to extract Cargo archive" >&2; exit 1; }

# ── 1. File listing ───────────────────────────────────────────────────────────
echo "1. File listing comparison"
BUCK2_FILES=$(cd "$BUCK2_DIR" && find . -type f | sort | sed 's|^\./||')
CARGO_FILES=$(cd "$CARGO_DIR" && find . -type f | sort | sed 's|^\./||')

if [[ "$BUCK2_FILES" == "$CARGO_FILES" ]]; then
  check_pass "file listing matches ($(echo "$BUCK2_FILES" | wc -l | tr -d ' ') files)"
else
  check_fail "file listing mismatch" ""
  echo "    Files only in Buck2:" >&2
  comm -23 <(echo "$BUCK2_FILES") <(echo "$CARGO_FILES") | sed 's/^/      /' >&2
  echo "    Files only in Cargo:" >&2
  comm -13 <(echo "$BUCK2_FILES") <(echo "$CARGO_FILES") | sed 's/^/      /' >&2
fi

# ── 2. Executable permissions ────────────────────────────────────────────────
echo "2. Executable permissions"
for f in "${EXEC_FILES[@]}"; do
  if [[ ! -f "$BUCK2_DIR/$f" ]]; then
    check_fail "$f not in Buck2 archive" "missing"
    continue
  fi
  if [[ ! -f "$CARGO_DIR/$f" ]]; then
    check_fail "$f not in Cargo archive" "missing"
    continue
  fi
  BUCK2_MODE=$(stat -c '%a' "$BUCK2_DIR/$f" 2>/dev/null || stat -f '%Lp' "$BUCK2_DIR/$f" 2>/dev/null)
  CARGO_MODE=$(stat -c '%a' "$CARGO_DIR/$f" 2>/dev/null || stat -f '%Lp' "$CARGO_DIR/$f" 2>/dev/null)
  if [[ "$BUCK2_MODE" == "$CARGO_MODE" ]]; then
    check_pass "$f mode matches ($BUCK2_MODE)"
  else
    check_fail "$f mode mismatch" "buck2=$BUCK2_MODE cargo=$CARGO_MODE"
  fi
done

# ── 3. VERSION content ───────────────────────────────────────────────────────
echo "3. VERSION file content"
if [[ -f "$BUCK2_DIR/VERSION" && -f "$CARGO_DIR/VERSION" ]]; then
  BUCK2_VER=$(tr -d '\n' < "$BUCK2_DIR/VERSION")
  CARGO_VER=$(tr -d '\n' < "$CARGO_DIR/VERSION")
  if [[ "$BUCK2_VER" == "$CARGO_VER" ]]; then
    check_pass "VERSION matches ($BUCK2_VER)"
  else
    check_fail "VERSION mismatch" "buck2='$BUCK2_VER' cargo='$CARGO_VER'"
  fi
else
  check_fail "VERSION file missing" "buck2 exists=$([[ -f "$BUCK2_DIR/VERSION" ]] && echo yes || echo no) cargo exists=$([[ -f "$CARGO_DIR/VERSION" ]] && echo yes || echo no)"
fi

# ── 4. BUILD_SHA content ─────────────────────────────────────────────────────
echo "4. BUILD_SHA file content"
if [[ -f "$BUCK2_DIR/BUILD_SHA" && -f "$CARGO_DIR/BUILD_SHA" ]]; then
  BUCK2_SHA=$(tr -d '\n' < "$BUCK2_DIR/BUILD_SHA")
  CARGO_SHA=$(tr -d '\n' < "$CARGO_DIR/BUILD_SHA")
  if [[ "$BUCK2_SHA" == "$CARGO_SHA" ]]; then
    check_pass "BUILD_SHA matches ($BUCK2_SHA)"
  else
    check_fail "BUILD_SHA mismatch" "buck2='$BUCK2_SHA' cargo='$CARGO_SHA'"
  fi
else
  check_fail "BUILD_SHA file missing" "buck2 exists=$([[ -f "$BUCK2_DIR/BUILD_SHA" ]] && echo yes || echo no) cargo exists=$([[ -f "$CARGO_DIR/BUILD_SHA" ]] && echo yes || echo no)"
fi

# ── 5. Gzip magic bytes ─────────────────────────────────────────────────────
echo "5. Gzip magic bytes"
for label in "buck2:$BUCK2_ARCHIVE" "cargo:$CARGO_ARCHIVE"; do
  name="${label%%:*}"
  path="${label#*:}"
  magic=$(od -A n -t x1 -N 2 "$path" 2>/dev/null | tr -d ' ')
  if [[ "$magic" == "1f8b" ]]; then
    check_pass "$name archive is valid gzip"
  else
    check_fail "$name archive is not valid gzip" "magic: $magic"
  fi
done

# ── 6. Binary sizes ─────────────────────────────────────────────────────────
echo "6. Binary sizes"
for f in "${EXEC_FILES[@]}"; do
  if [[ -f "$BUCK2_DIR/$f" && -f "$CARGO_DIR/$f" ]]; then
    BUCK2_SIZE=$(stat -f '%z' "$BUCK2_DIR/$f" 2>/dev/null || stat -c '%s' "$BUCK2_DIR/$f" 2>/dev/null)
    CARGO_SIZE=$(stat -f '%z' "$CARGO_DIR/$f" 2>/dev/null || stat -c '%s' "$CARGO_DIR/$f" 2>/dev/null)
    DIFF=$((BUCK2_SIZE - CARGO_SIZE))
    ABS_DIFF=${DIFF#-}
    if [[ $ABS_DIFF -le $SIZE_TOLERANCE ]]; then
      check_pass "$f size within tolerance (buck2=$BUCK2_SIZE cargo=$CARGO_SIZE diff=${DIFF})"
    else
      check_fail "$f size exceeds tolerance" "buck2=$BUCK2_SIZE cargo=$CARGO_SIZE diff=${DIFF} (tolerance=$SIZE_TOLERANCE)"
    fi
  fi
done

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary: $PASS passed, $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
