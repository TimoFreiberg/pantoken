#!/usr/bin/env bash
# AC.10: Asserts the findings report exists and contains required sections.
set -euo pipefail

REPORT="docs/bazel-poc-findings.md"

if [ ! -f "$REPORT" ]; then
    echo "FAIL: $REPORT not found"
    exit 1
fi

echo "Checking $REPORT for required sections..."

REQUIRED_SECTIONS=(
    "## Timings"
    "## Cache reuse"
    "## Affected-target execution"
    "## Correctness invalidation"
    "## Ergonomics assessment"
    "## Known gaps"
    "## Decision gate"
)

FAIL=0
for section in "${REQUIRED_SECTIONS[@]}"; do
    if grep -qF "$section" "$REPORT"; then
        echo "  ✓ Found: $section"
    else
        echo "  ✗ Missing: $section"
        FAIL=1
    fi
done

# Check for proceed/stop recommendation
if grep -qiE "PROCEED|STOP" "$REPORT"; then
    echo "  ✓ Found: proceed/stop recommendation"
else
    echo "  ✗ Missing: proceed/stop recommendation"
    FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
    echo "PASS: All required sections found in findings report"
    exit 0
else
    echo "FAIL: Missing required sections in findings report"
    exit 1
fi
