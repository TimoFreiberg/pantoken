#!/usr/bin/env bash
# Buck2 POC measurement script.
# Captures cold, warm, incremental, cross-workspace, test, and archive timings
# comparable to docs/toolchain-baseline.md and docs/bazel-poc-findings.md.
#
# Usage: just buck2-measure
# Prerequisites: Buck2, Reindeer, Rust 1.97.1, sccache

set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
export OPENSSL_DIR="/opt/homebrew/opt/openssl@3"

REPO_ROOT=$(pwd)
BUCK2="/Users/timo/.local/bin/buck2"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MACHINE=$(uname -srm)
RUSTC_VER=$($HOME/.cargo/bin/rustc --version 2>/dev/null || echo "unknown")
BUCK2_VER=$("$BUCK2" --version 2>/dev/null || echo "unknown")

# Targets that build successfully (excluding pantoken-server due to OpenSSL blocker)
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

timer() {
  local start=$EPOCHREALTIME
  "$@"
  local end=$EPOCHREALTIME
  echo "$end - $start" | bc
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

# Incremental (touch one file)
echo -n "| Incremental (1 file) | "
TARGET_FILE="server-rs/pantoken-protocol/src/lib.rs"
# Save original content for restore
ORIG_CONTENT=$(cat "$TARGET_FILE")
trap 'echo "$ORIG_CONTENT" > "$TARGET_FILE"' EXIT
touch "$TARGET_FILE"
INCR_TIME=$(timer "$BUCK2" build "${BUILD_TARGETS[@]}" 2>/dev/null)
echo "${INCR_TIME}s | Touched protocol/src/lib.rs |"
# Restore original content
echo "$ORIG_CONTENT" > "$TARGET_FILE"
trap - EXIT

# Test run
echo -n "| Test run | "
TEST_TIME=$(timer "$BUCK2" test "${TEST_TARGETS[@]}" 2>/dev/null)
echo "${TEST_TIME}s | 5 test targets |"

# Archive build (if client/dist exists)
if [ -d "client/dist" ] && [ -f "client/dist/index.html" ]; then
  echo -n "| Archive build | "
  ARCHIVE_TIME=$(timer "$BUCK2" build '//:pantoken_headless_unsigned' 2>/dev/null)
  echo "${ARCHIVE_TIME}s | Unsigned headless archive |"
else
  echo "| Archive build | skipped | client/dist not built (run \`just build-client\` first) |"
fi

# Cross-workspace cache reuse
echo -n "| Cross-workspace (cache) | "
"$BUCK2" clean 2>/dev/null || true
XWORKSPACE_TIME=$(timer "$BUCK2" build "${BUILD_TARGETS[@]}" 2>/dev/null)
echo "${XWORKSPACE_TIME}s | After buck2 clean, action cache cold but deps cached |"

echo ""
echo "## Comparison with Cargo baseline and Bazel POC"
echo ""
echo "| Metric | Buck2 | Bazel | Cargo baseline |"
echo "|--------|-------|-------|----------------|"
echo "| Cold build | ${COLD_TIME}s | 32s | 11.4s |"
echo "| Warm build | ${WARM_TIME}s | <1s | 8.4s |"
echo "| Incremental | ${INCR_TIME}s | 1s | 2.5s |"
echo "| Test run | ${TEST_TIME}s | ~30s | N/A |"
echo ""
echo "## Notes"
echo "- Buck2 builds 4 of 5 server crates (pantoken-server blocked by OpenSSL/ring)"
echo "- Reindeer-generated dependency graph: 353 vendored crates, 335MB"
echo "- All builds use the system Rust toolchain (1.97.1 via rustup)"
echo "- Buck2 does not use sccache (independent cache mechanism)"
echo "- x86_64-unknown-linux-gnu is excluded from Buck2 targets"
