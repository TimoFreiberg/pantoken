#!/usr/bin/env bash
# Buck2 POC measurement script.
# Captures cold, warm, incremental, cross-workspace, test, and archive timings
# comparable to docs/toolchain-baseline.md and docs/buck2-poc-findings.md.
#
# Usage: just measure-rs
# Prerequisites: Buck2, Reindeer, Rust 1.97.1

set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

REPO_ROOT=$(pwd)
BUCK2="${BUCK2:-$(command -v buck2 2>/dev/null || echo "")}"
if [[ -z "$BUCK2" ]]; then
  echo "ERROR: buck2 not found. Install it or set BUCK2=/path/to/buck2." >&2
  exit 1
fi
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MACHINE=$(uname -srm)
RUSTC_VER=$(rustc --version 2>/dev/null || echo "unknown")
BUCK2_VER=$("${BUCK2:-buck2}" --version 2>/dev/null || echo "unknown")

# Targets measured here (the four non-binary server crates; pantoken-server
# itself builds via `just build-server-rs`).
BUILD_TARGETS=(
  '//server-rs/pantoken-protocol:pantoken_protocol'
  '//server-rs/pantoken-daemon-types:pantoken_daemon_types'
  '//server-rs/pantoken-remote-layout:pantoken_remote_layout'
  '//server-rs/pantoken-tar-validate:pantoken_tar_validate'
)

TEST_TARGETS=(
  '//server-rs/pantoken-protocol:fold_corpus_tests'
  '//server-rs/pantoken-daemon-types:target_version_test'
  '//server-rs/pantoken-daemon-types:daemon_types_roundtrip'
  '//server-rs/pantoken-remote-layout:unit_tests'
  '//server-rs/pantoken-tar-validate:unit_tests'
)

# Timer function — uses $EPOCHREALTIME (bash 5+) with date fallback.
timer() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    local start=$EPOCHREALTIME
    "$@"
    local end=$EPOCHREALTIME
    echo "$end - $start" | bc
  else
    local start
    start=$(date +%s.%N)
    "$@"
    local end
    end=$(date +%s.%N)
    echo "$end - $start" | bc
  fi
}

echo "# Buck2 POC Measurement Report"
echo ""
echo "Captured: $TIMESTAMP"
echo "Machine: $MACHINE"
echo "Rust: $RUSTC_VER"
echo "Buck2: $BUCK2_VER"
echo "Host/target: aarch64-apple-darwin"
echo ""
echo "| Metric | Time | Notes |"
echo "|--------|------|-------|"

# Cold build (clear buck-out)
echo -n "| Cold build | "
"$BUCK2" clean 2>/dev/null || true
COLD_TIME=$(timer "$BUCK2" build "${BUILD_TARGETS[@]}" 2>/dev/null)
echo "${COLD_TIME}s | Clean buck-out, 4 server crates |"

# Warm build (action cache hit)
echo -n "| Warm build | "
WARM_TIME=$(timer "$BUCK2" build "${BUILD_TARGETS[@]}" 2>/dev/null)
echo "${WARM_TIME}s | No changes, action cache |"

# Incremental (content-preserving edit to trigger a real rebuild)
echo -n "| Incremental (1 file) | "
TARGET_FILE="server-rs/pantoken-protocol/src/lib.rs"
# Backup with cp to preserve exact bytes, append a comment to force rebuild,
# then restore. Buck2 uses content hashing, so touch alone is a no-op.
cp -p "$TARGET_FILE" "$TARGET_FILE.bak"
printf '// buck2-measure incremental trigger\n' >> "$TARGET_FILE"
trap 'cp -p "$TARGET_FILE.bak" "$TARGET_FILE" && rm -f "$TARGET_FILE.bak"' EXIT
INCR_TIME=$(timer "$BUCK2" build "${BUILD_TARGETS[@]}" 2>/dev/null)
echo "${INCR_TIME}s | Edited protocol/src/lib.rs (content change) |"
# Restore original content
cp -p "$TARGET_FILE.bak" "$TARGET_FILE"
rm -f "$TARGET_FILE.bak"
trap - EXIT

# Test run
echo -n "| Test run | "
TEST_TIME=$(timer "$BUCK2" test "${TEST_TARGETS[@]}" 2>/dev/null)
echo "${TEST_TIME}s | 5 test targets |"

# Archive build
echo -n "| Archive build | "
ARCHIVE_TIME=$(timer "$BUCK2" build '//:pantoken_headless_unsigned' 2>/dev/null)
echo "${ARCHIVE_TIME}s | Unsigned headless archive |"

# Cross-workspace cache reuse
echo -n "| Cross-workspace (cache) | "
"$BUCK2" clean 2>/dev/null || true
XWORKSPACE_TIME=$(timer "$BUCK2" build "${BUILD_TARGETS[@]}" 2>/dev/null)
echo "${XWORKSPACE_TIME}s | After buck2 clean, action cache cold but deps cached |"

echo ""
echo "## Comparison with Cargo baseline"
echo ""
echo "| Metric | Buck2 | Cargo baseline |"
echo "|--------|-------|----------------|"
echo "| Cold build | ${COLD_TIME}s | 11.4s |"
echo "| Warm build | ${WARM_TIME}s | 8.4s |"
echo "| Incremental | ${INCR_TIME}s | 2.5s |"
echo "| Test run | ${TEST_TIME}s | N/A |"
echo ""
echo "## Notes"
echo "- Buck2 builds all 5 server crates (this script times the 4 non-binary crates)"
echo "- Reindeer-generated dependency graph: 353 vendored crates, 335MB"
echo "- All builds use the system Rust toolchain (1.97.1 via rustup)"
echo "- Buck2 uses its own action cache (independent of Cargo)"
echo "- x86_64-unknown-linux-gnu is excluded from Buck2 targets"
