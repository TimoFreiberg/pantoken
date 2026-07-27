#!/usr/bin/env bash
# Measure Bazel POC timings for the findings report.
# Captures: clean build, warm build, incremental (affected-target), test run, archive build.
# Compare against Cargo baseline in docs/toolchain-baseline.md.
set -euo pipefail

cd "$(dirname "$0")/../.."

BAZEL="bazel"
RESULTS_FILE="${1:-scripts/bazel/results.txt}"

echo "=== Bazel POC Measurement ===" | tee "$RESULTS_FILE"
echo "Date: $(date)" | tee -a "$RESULTS_FILE"
echo "Machine: $(uname -s) $(uname -r) ($(uname -m))" | tee -a "$RESULTS_FILE"
echo "" | tee -a "$RESULTS_FILE"

# --- Clean build (expunge + build) ---
echo "=== Clean build (bazel clean --expunge + build //server-rs/...) ===" | tee -a "$RESULTS_FILE"
$BAZEL clean --expunge 2>&1 | tail -1
START=$(date +%s)
$BAZEL build //server-rs/... 2>&1 | tail -3 | tee -a "$RESULTS_FILE"
END=$(date +%s)
CLEAN_TIME=$((END - START))
echo "Clean build time: ${CLEAN_TIME}s" | tee -a "$RESULTS_FILE"
echo "" | tee -a "$RESULTS_FILE"

# --- Warm build (second run, all cached) ---
echo "=== Warm build (bazel build //server-rs/...) ===" | tee -a "$RESULTS_FILE"
START=$(date +%s)
$BAZEL build //server-rs/... 2>&1 | tail -3 | tee -a "$RESULTS_FILE"
END=$(date +%s)
WARM_TIME=$((END - START))
echo "Warm build time: ${WARM_TIME}s" | tee -a "$RESULTS_FILE"
echo "" | tee -a "$RESULTS_FILE"

# --- Incremental / affected-target ---
echo "=== Incremental build (touch protocol/src/lib.rs + build //server-rs/...) ===" | tee -a "$RESULTS_FILE"
touch server-rs/pantoken-protocol/src/lib.rs
START=$(date +%s)
$BAZEL build //server-rs/... --explain=/tmp/bazel-incremental-explain.txt 2>&1 | tail -3 | tee -a "$RESULTS_FILE"
END=$(date +%s)
INCR_TIME=$((END - START))
echo "Incremental build time: ${INCR_TIME}s" | tee -a "$RESULTS_FILE"
# Count how many actions actually ran (non-cache hits)
ACTIONS=$(grep -c "^Action " /tmp/bazel-incremental-explain.txt 2>/dev/null || echo "0")
echo "Actions executed (non-cache): ${ACTIONS}" | tee -a "$RESULTS_FILE"
echo "" | tee -a "$RESULTS_FILE"

# --- Test run ---
echo "=== Test run (bazel test //server-rs/...) ===" | tee -a "$RESULTS_FILE"
START=$(date +%s)
$BAZEL test //server-rs/... 2>&1 | tail -5 | tee -a "$RESULTS_FILE"
END=$(date +%s)
TEST_TIME=$((END - START))
echo "Test run time: ${TEST_TIME}s" | tee -a "$RESULTS_FILE"
echo "" | tee -a "$RESULTS_FILE"

# --- Archive build ---
echo "=== Archive build (bazel build //:pantoken_headless_unsigned) ===" | tee -a "$RESULTS_FILE"
START=$(date +%s)
$BAZEL build //:pantoken_headless_unsigned 2>&1 | tail -3 | tee -a "$RESULTS_FILE"
END=$(date +%s)
ARCHIVE_TIME=$((END - START))
echo "Archive build time: ${ARCHIVE_TIME}s" | tee -a "$RESULTS_FILE"
echo "" | tee -a "$RESULTS_FILE"

# --- Summary ---
echo "=== Summary ===" | tee -a "$RESULTS_FILE"
echo "Clean build:   ${CLEAN_TIME}s  (Cargo baseline: 11.4s)" | tee -a "$RESULTS_FILE"
echo "Warm build:    ${WARM_TIME}s  (Cargo baseline: 8.4s)" | tee -a "$RESULTS_FILE"
echo "Incremental:   ${INCR_TIME}s  (Cargo baseline: 2.5s)" | tee -a "$RESULTS_FILE"
echo "Test run:      ${TEST_TIME}s" | tee -a "$RESULTS_FILE"
echo "Archive build: ${ARCHIVE_TIME}s" | tee -a "$RESULTS_FILE"
