#!/usr/bin/env bash
# Validate the durable timing-audit artifact produced for the timing test work.
set -euo pipefail

CHECK_NAME="${1:-timing_audit_artifact_exists_and_contains_required_inventory}"
REPORT="/Users/timo/.local/share/polytoken/sessions/07nxra-jolly/implementation-report.md"

if [[ "$CHECK_NAME" != "timing_audit_artifact_exists_and_contains_required_inventory" ]]; then
  printf 'unknown check: %s\n' "$CHECK_NAME" >&2
  exit 2
fi

test -s "$REPORT"

required_strings=(
  'std::thread::sleep'
  'tokio::time::sleep'
  'timeout'
  'timeout_at'
  'Instant::now'
  'SystemTime::now'
  'elapsed'
)
for required in "${required_strings[@]}"; do
  grep -Fq -- "$required" "$REPORT" || {
    printf 'timing audit missing required string: %s\n' "$required" >&2
    exit 1
  }
done

for header in 'file' 'line/test' 'timing API' 'classification' 'rationale'; do
  grep -Fq -- "$header" "$REPORT" || {
    printf 'timing audit missing inventory header: %s\n' "$header" >&2
    exit 1
  }
done

grep -Eiq -- 'usage[- ]throttl|usage_poll|usage poll' "$REPORT" || {
  echo 'timing audit missing usage-throttling inventory/follow-up' >&2
  exit 1
}

grep -Fqi -- 'focused tests' "$REPORT" || {
  echo 'timing audit missing focused tests section' >&2
  exit 1
}

printf '%s: ok (%s)\n' "$CHECK_NAME" "$REPORT"
