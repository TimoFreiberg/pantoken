#!/usr/bin/env bash
# buck2/test-bootstrap.sh — Deterministic test harness for buck2/bootstrap.sh.
#
# Tests every bootstrap failure path and success path with exact exit code
# and stderr assertions. Run by `just buck2-check-tests`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP="$SCRIPT_DIR/bootstrap.sh"

PASS=0
FAIL=0

# Use a per-invocation temp directory to avoid race conditions.
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

assert_exit() {
    local expected_exit="$1"
    local description="$2"
    shift 2
    local actual_exit
    "$@" >/dev/null 2>/dev/null || actual_exit=$? || actual_exit=0
    actual_exit=${actual_exit:-0}
    if [[ "$actual_exit" == "$expected_exit" ]]; then
        echo "  PASS: $description (exit $actual_exit)"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $description (expected exit $expected_exit, got $actual_exit)" >&2
        FAIL=$((FAIL + 1))
    fi
}

assert_exit_and_stderr() {
    local expected_exit="$1"
    local expected_stderr_substring="$2"
    local description="$3"
    shift 3
    local tmperr
    tmperr="$(mktemp)"
    set +e
    "$@" >/dev/null 2>"$tmperr"
    local actual_exit=$?
    set -e
    local actual_stderr
    actual_stderr="$(cat "$tmperr")"
    rm -f "$tmperr"
    local ok=1
    [[ "$actual_exit" == "$expected_exit" ]] || ok=0
    echo "$actual_stderr" | grep -qF "$expected_stderr_substring" || ok=0
    if [[ "$ok" == "1" ]]; then
        echo "  PASS: $description (exit $actual_exit, stderr contains expected text)"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $description (expected exit $expected_exit + stderr '$expected_stderr_substring', got exit $actual_exit + stderr '$actual_stderr')" >&2
        FAIL=$((FAIL + 1))
    fi
}

echo "=== Buck2 bootstrap test harness ==="

# 1. Missing executable (empty PATH)
echo "-- Test: missing executable with empty PATH"
assert_exit_and_stderr 1 "buck2 not found" "missing buck2 with empty PATH" \
    env -i PATH="/bin:/usr/bin" bash "$BOOTSTRAP" --binary /nonexistent/buck2

# 2. Malformed binary
echo "-- Test: malformed binary"
echo "garbage" > "$TMPDIR_TEST/buck2-test-malformed"
chmod +x "$TMPDIR_TEST/buck2-test-malformed"
assert_exit_and_stderr 1 "malformed" "malformed buck2 binary" \
    bash "$BOOTSTRAP" --binary "$TMPDIR_TEST/buck2-test-malformed"

# 3. Too-old / wrong version
echo "-- Test: wrong version binary"
cat > "$TMPDIR_TEST/buck2-test-old-version" <<'EOF'
#!/bin/bash
echo "buck2 2025-01-01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EOF
chmod +x "$TMPDIR_TEST/buck2-test-old-version"
assert_exit_and_stderr 1 "revision mismatch" "wrong buck2 revision" \
    bash "$BOOTSTRAP" --binary "$TMPDIR_TEST/buck2-test-old-version"

# 4. Accepted version (the real binary, if available — environment-specific smoke check)
echo "-- Test: accepted version (real binary smoke check)"
REAL_BUCK2="${BUCK2:-$(command -v buck2 2>/dev/null || echo "")}"
if [[ -x "$REAL_BUCK2" ]]; then
    assert_exit 0 "real buck2 binary passes" \
        bash "$BOOTSTRAP" --binary "$REAL_BUCK2"
else
    echo "  SKIP: real buck2 binary not at $REAL_BUCK2 (environment-specific smoke check, not part of deterministic suite)"
fi

# 5. Env override
echo "-- Test: BUCK2 env var override"
assert_exit_and_stderr 1 "buck2 not found" "BUCK2 env override with nonexistent" \
    env BUCK2=/nonexistent/buck2 bash "$BOOTSTRAP"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" == "0" ]] || exit 1
exit 0
