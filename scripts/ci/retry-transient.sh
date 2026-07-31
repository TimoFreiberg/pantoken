#!/usr/bin/env bash
# Retry a failing CI command once when its output looks like a transient
# network/DNS failure (e.g. Buck2 unable to download a crate from crates.io).
#
# GitHub-hosted runners occasionally hit short-lived DNS/connection blips when
# fetching third-party crates; the failure is real but usually gone on the
# next attempt (v0.2.94's release died in exactly such a window — see
# docs/buck2-policy.md). A blind retry, however, would re-run failing tests
# and mask genuine compile/assertion errors. So this wrapper re-runs ONLY when
# the captured output matches TRANSIENT_RE — tight, network-specific error
# strings — and even then only once (2 attempts total). Every other failure
# exits with the command's original exit code, unchanged.
#
# Usage:
#   bash scripts/ci/retry-transient.sh 'command string'
#
# The command runs under `bash -eo pipefail -c "$1"`, so compound commands
# (`just a && just b`) and heredocs behave exactly like a normal `run:` step.
# Output streams to the step log live (tee), so nothing is hidden on success.
#
# Tune with env vars (defaults shown):
#   RETRY_TRANSIENT_MAX_ATTEMPTS=2   total runs (1 original + 1 retry)
#   RETRY_TRANSIENT_SLEEP_SECONDS=5  pause before the retry

set -euo pipefail

MAX_ATTEMPTS="${RETRY_TRANSIENT_MAX_ATTEMPTS:-2}"
SLEEP_SECONDS="${RETRY_TRANSIENT_SLEEP_SECONDS:-5}"

# Error strings glibc, curl, and reqwest-style HTTP clients emit for DNS
# resolution failures, refused/reset/timed-out connections, and download
# failures — the transient class that kills Buck2's crates.io fetches.
# Deliberately tight: a false positive costs one extra run of the command (the
# step still fails loudly if the problem is real); a false negative costs
# nothing (no retry — exactly today's behavior).
TRANSIENT_RE='Temporary failure in name resolution|Name or service not known|failed to lookup address information|[Cc]ould not resolve host|dns error|dns_error|[Cc]onnection (reset|refused|timed out|closed)|connection lost|[Nn]etwork (is unreachable|error)|[Nn]o route to host|[Ff]ailed to fetch|[Ff]ailed to download|[Cc]ould not download|error sending request for url|failed to make network request|unexpected eof|UnexpectedEof|curl: \((6|7|28|35|56)\)'

if [ "$#" -ne 1 ]; then
  echo "usage: $0 'command string'" >&2
  exit 2
fi

command_str="$1"

attempt=1
while :; do
  log="$(mktemp "${TMPDIR:-/tmp}/retry-transient.XXXXXX")"
  set +e
  bash -eo pipefail -c "$command_str" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e

  if [ "$rc" -eq 0 ]; then
    rm -f "$log"
    exit 0
  fi

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ] && grep -qE "$TRANSIENT_RE" "$log"; then
    echo "::warning::transient-looking network/DNS failure (attempt $attempt/$MAX_ATTEMPTS); retrying in ${SLEEP_SECONDS}s" >&2
    rm -f "$log"
    attempt=$((attempt + 1))
    sleep "$SLEEP_SECONDS"
    continue
  fi

  rm -f "$log"
  exit "$rc"
done
