#!/usr/bin/env bash
# parse-triage.sh — extract the JSON decision line from polytoken exec stdout.
#
# exec may emit surrounding text (thinking, tool output, etc.). This script
# scans stdin line by line for the first line that looks like a valid
# {"status":...} JSON object, validates it, and echoes it to stdout.
# Falls back to {"status":"error"} if no valid JSON is found.
#
# Usage: polytoken exec ... | parse-triage.sh
set -euo pipefail

# Read all stdin, then scan for the JSON line
# We look for lines matching {"status":"..."} pattern
RESULT=""

while IFS= read -r line || [ -n "$line" ]; do
  # Skip empty lines
  [ -z "$line" ] && continue

  # Try to match a JSON object with "status" key
  # Use a simple check: line starts with { and contains "status"
  case "$line" in
    *'"status"'*)
      # Validate it's parseable JSON with a "status" field
      if echo "$line" | jq -e '.status' >/dev/null 2>&1; then
        RESULT="$line"
        break
      fi
      ;;
  esac
done

if [ -z "$RESULT" ]; then
  echo '{"status":"error"}'
  exit 0
fi

echo "$RESULT"
