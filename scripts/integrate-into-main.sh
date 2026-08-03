#!/usr/bin/env bash
# integrate-into-main.sh — linearize jj history onto main and push.
#
# Implements a hybrid lock model: the script owns the lock (file-based,
# survives process death), and conflict resolution is delegated back to
# the calling agent via exit code 2.
#
# Must be run from inside the implementer's jj workspace.
#
# Usage: integrate-into-main.sh <issue_number>
# Exit codes: 0=success, 2=conflicts (lock held, resolve and retry), 1=error
#
# Environment:
#   INTEGRATE_DRY_RUN=1  Skip push and gh issue close (for testing)
set -euo pipefail

ISSUE_NUMBER="${1:?usage: integrate-into-main.sh <issue_number>}"
if ! [[ "$ISSUE_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: issue_number must be a positive integer" >&2
  exit 1
fi

REPO_ROOT="${PANTOKEN_REPO_ROOT:-$(jj root 2>/dev/null || true)}"
if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: run from a jj workspace or set PANTOKEN_REPO_ROOT" >&2
  exit 1
fi
REPO_ROOT=$(cd "$REPO_ROOT" && pwd -P)
LOCK_FILE="$REPO_ROOT/.merge-lock"
STALE_THRESHOLD=1800  # 30 minutes in seconds
POLL_INTERVAL=2       # seconds between lock polls

log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

# ─── Read session ID from workspace ──────────────────────────────────────────

SESSION_FILE="$PWD/.implement-issue-session-id"
CURRENT_SESSION=""
if [ -f "$SESSION_FILE" ]; then
  CURRENT_SESSION=$(cat "$SESSION_FILE" 2>/dev/null || true)
fi

# ─── Lock acquisition ────────────────────────────────────────────────────────

# Check if a PID is alive
_pid_alive() {
  local pid=$1
  [ "$pid" -gt 0 ] 2>/dev/null || return 1
  kill -0 "$pid" 2>/dev/null
}

# Write lock JSON to a temp file, then atomically move it into place
_write_lock() {
  local tmpfile
  tmpfile=$(mktemp)
  jq -n \
    --argjson pid "$$" \
    --arg sid "$CURRENT_SESSION" \
    --argjson issue "$ISSUE_NUMBER" \
    --argjson ts "$(date +%s)" \
    '{pid:$pid, session_id:$sid, issue_number:$issue, timestamp:$ts}' \
    > "$tmpfile"
  mv -f "$tmpfile" "$LOCK_FILE"
}

acquire_lock() {
  local lock_json
  lock_json=$(jq -n \
    --argjson pid "$$" \
    --arg sid "$CURRENT_SESSION" \
    --argjson issue "$ISSUE_NUMBER" \
    --argjson ts "$(date +%s)" \
    '{pid:$pid, session_id:$sid, issue_number:$issue, timestamp:$ts}')

  while true; do
    # Attempt atomic creation with noclobber (in a subshell so it doesn't leak)
    if (set -o noclobber; echo "$lock_json" > "$LOCK_FILE") 2>/dev/null; then
      # We hold the lock
      return 0
    fi

    # File exists — malformed metadata is conservative: never steal it.
    local existing_pid existing_sid existing_ts
    if ! jq -e '(.pid | type == "number" and . >= 1 and floor == .) and (.session_id | type == "string") and (.timestamp | type == "number" and . >= 1 and floor == .)' "$LOCK_FILE" >/dev/null 2>&1; then
      log "Malformed or unsafe lock metadata in $LOCK_FILE; recover it manually"
      sleep "$POLL_INTERVAL"
      continue
    fi
    existing_pid=$(jq -r '.pid' "$LOCK_FILE")
    existing_sid=$(jq -r '.session_id' "$LOCK_FILE")
    existing_ts=$(jq -r '.timestamp' "$LOCK_FILE")

    if _pid_alive "$existing_pid"; then
      # PID is alive — another integration is in progress
      log "Another integration in progress (PID $existing_pid, session $existing_sid), waiting..."
      sleep "$POLL_INTERVAL"
      continue
    fi

    # PID is dead — check if same session (retry after conflict resolution)
    if [ "$existing_sid" = "$CURRENT_SESSION" ] && [ -n "$CURRENT_SESSION" ]; then
      # Same session re-acquisition — immediate
      log "Re-acquiring lock (same session, PID $existing_pid dead)"
      _write_lock
      return 0
    fi

    # PID dead, different session — check lock age
    local now lock_age
    now=$(date +%s)
    lock_age=$((now - existing_ts))

    if [ "$lock_age" -lt "$STALE_THRESHOLD" ]; then
      # Recent lock from a different session — likely resolving conflicts
      log "Integration in progress (session $existing_sid appears to be resolving conflicts, waiting...)"
      sleep "$POLL_INTERVAL"
      continue
    fi

    # Stale lock — steal it
    local age_min=$((lock_age / 60))
    log "Stale lock detected (PID $existing_pid dead, age ${age_min}m, session $existing_sid), taking over"
    _write_lock
    return 0
  done
}

release_lock() {
  if [ ! -f "$LOCK_FILE" ]; then return 0; fi
  if ! jq -e --argjson pid "$$" --arg sid "$CURRENT_SESSION" '.pid == $pid and .session_id == $sid' "$LOCK_FILE" >/dev/null 2>&1; then
    log "Not removing merge lock: on-disk owner does not match PID $$ and session $CURRENT_SESSION"
    return 0
  fi
  rm -f "$LOCK_FILE" 2>/dev/null || true
}

# ─── Verify commit history before taking the lock ─────────────────────────────
# Read-only checks: no rebase or lock mutation has happened yet, so failure
# is a clean exit 1 with no rollback needed.
COMMIT_MESSAGES=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'description' 2>/dev/null || true)
if [ -n "$COMMIT_MESSAGES" ]; then
  # Verify exactly one non-empty commit above main (squash enforcement)
  NON_EMPTY_COMMIT_IDS=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id ++ "\n"' 2>/dev/null || true)
  NON_EMPTY_COUNT=$(printf '%s' "$NON_EMPTY_COMMIT_IDS" | grep -c . || true)
  if [ "$NON_EMPTY_COUNT" -gt 1 ]; then
    log "ERROR: found $NON_EMPTY_COUNT non-empty commits above main — expected exactly one."
    log "Commits that must be squashed:"
    while IFS= read -r commit_id; do
      [ -n "$commit_id" ] && log "  $commit_id"
    done <<< "$NON_EMPTY_COMMIT_IDS"
    log "Squash them into a single commit, then rerun 'just integrate-into-main $ISSUE_NUMBER'."
    exit 1
  fi

  # Verify commit message includes Fixes #<issue_number>
  log "Verifying commit message includes 'Fixes #$ISSUE_NUMBER'..."
  if ! echo "$COMMIT_MESSAGES" | grep -Eqi "fixes #$ISSUE_NUMBER([^0-9]|$)"; then
    log "ERROR: no commit in main..@ contains 'Fixes #$ISSUE_NUMBER' in its message."
    log "Amend your commit message to include 'Fixes #$ISSUE_NUMBER' on its own line"
    log "after the subject, then rerun 'just integrate-into-main $ISSUE_NUMBER'."
    exit 1
  fi
fi

# ─── Acquire lock ────────────────────────────────────────────────────────────

acquire_lock
log "Lock acquired (PID $$, session $CURRENT_SESSION)"

# Ensure lock is released on unexpected exit (but NOT on conflict — exit 2 keeps it).
# Once rebase completes, every pre-bookmark failure restores the captured operation
# exactly once. The gate owns its descendants; on interruption, terminate the gate
# process group before restoring jj so no child can continue against the restored tree.
RELEASE_ON_EXIT=true
REBASE_COMPLETED=false
ROLLBACK_DONE=false
BOOKMARK_MOVE_STARTED=false
PUSH_STARTED=false
ORIGINAL_STATUS=1
GATE_PID=""
GATE_PGID=""

_release_if_needed() {
  local status=$?
  if [ "$RELEASE_ON_EXIT" = true ]; then
    if [ "$status" -ne 0 ] && [ "$REBASE_COMPLETED" = true ] && [ "$BOOKMARK_MOVE_STARTED" = false ] && [ "$PUSH_STARTED" = false ]; then
      rollback_after_rebase "$status"
      return
    fi
    release_lock
  fi
}

_wait_for_gate() {
  if [ -n "$GATE_PID" ]; then
    wait "$GATE_PID" 2>/dev/null || true
    GATE_PID=""
  fi
}

_terminate_gate() {
  if [ -n "$GATE_PID" ] && kill -0 "$GATE_PID" 2>/dev/null; then
    local group="${GATE_PGID:-$GATE_PID}"
    kill -TERM -- "-$group" 2>/dev/null || kill -TERM "$GATE_PID" 2>/dev/null || true
    _wait_for_gate
  fi
}

rollback_after_rebase() {
  local status="${1:-1}"
  if [ "$REBASE_COMPLETED" != true ] || [ "$ROLLBACK_DONE" = true ]; then
    release_lock
    RELEASE_ON_EXIT=false
    return "$status"
  fi
  ROLLBACK_DONE=true
  trap - EXIT INT TERM
  _terminate_gate
  log "Restoring pre-rebase operation after failed local gate..."
  if ! jj op restore "$PRE_REBASE_OP"; then
    log "ERROR: failed to restore pre-rebase operation $PRE_REBASE_OP"
    status=1
  fi
  release_lock
  RELEASE_ON_EXIT=false
  return "$status"
}

_on_signal() {
  local signal_status=1
  case "$1" in INT) signal_status=130 ;; TERM) signal_status=143 ;; esac
  log "Integration interrupted; stopping local gate before rollback"
  rollback_after_rebase "$signal_status"
  exit "$signal_status"
}

trap _release_if_needed EXIT
trap '_on_signal INT' INT
trap '_on_signal TERM' TERM

# ─── Integration steps ────────────────────────────────────────────────────────

# 1. Fetch latest main
log "Fetching latest main..."
jj git fetch

# 2. Capture pre-rebase op ID for rollback
PRE_REBASE_OP=$(jj op log --limit 1 --no-graph -T id)
log "Pre-rebase op: $PRE_REBASE_OP"

# 3. Guard: check for non-empty commits in main..@
NON_EMPTY_COMMITS=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | head -1)
if [ -z "$NON_EMPTY_COMMITS" ]; then
  log "No non-empty commits in main..@ — nothing to push"
  release_lock
  RELEASE_ON_EXIT=false
  exit 0
fi

# 4. Rebase new commits onto the latest main
#
# Choose the rebase destination dynamically: when local main is a descendant
# of main@origin (local is ahead or equal), rebasing onto main@origin would
# move commits to an *older* base — a no-op at best, and at worst it detaches
# them from local main's lineage. Use local main instead, which is a no-op
# rebase that keeps commits in place.
#
# When main@origin has commits local main doesn't (remote is ahead or
# diverged), rebase onto main@origin to incorporate them.
REBASE_DEST="main"
if jj log -r 'main@origin' --no-graph 2>/dev/null | grep -q .; then
  # main@origin exists — use it only when local main is NOT a descendant
  if ! jj log -r 'main@origin & ::main' --no-graph 2>/dev/null | grep -q .; then
    REBASE_DEST="main@origin"
  fi
fi
log "Rebasing main..@ ~ empty() onto $REBASE_DEST..."
# Capture the content commit's change ID before rebase. jj preserves change
# IDs across rebase, so we can reattach @ afterward by its change ID even if
# the rebase detaches the working copy from the content commit.
CONTENT_CHANGE=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'change_id' 2>/dev/null | tail -1)

# Exclude the empty working-copy commit (@) from the rebase source: when @ is
# included, jj rebases it as a separate commit onto the destination, making it
# a sibling of the feature commit rather than its child. This breaks the
# main..@ ~ empty() query used later to find the target commit.
#
# Side effect: excluding @ also means jj doesn't move @ on top of the rebased
# content commit — it leaves @ behind at its old position. We reattach it
# with `jj new` after the conflict check below.
REBASE_STATUS=0
jj rebase -s 'main..@ ~ empty()' -d "$REBASE_DEST" 2>/dev/null || REBASE_STATUS=$?

# 5. Classify rebase failures before running tests.
CONFLICTS=$(jj resolve --list 2>/dev/null | head -1 || true)
if [ -n "$CONFLICTS" ]; then
  log "CONFLICTS DETECTED — resolve them using the jj-resolve-conflicts skill,"
  log "then call 'just integrate-into-main $ISSUE_NUMBER' again. The lock is still held."
  RELEASE_ON_EXIT=false
  exit 2
fi
if [ "$REBASE_STATUS" -ne 0 ]; then
  log "ERROR: rebase failed without conflicts — rolling back to pre-rebase state"
  log "Inspect the jj error, fix the underlying problem, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
  rollback_after_rebase 1
  exit 1
fi

# 5b. Reattach the working copy on top of the rebased content commit.
# The rebase excluded @ (to keep it from becoming a sibling), but that also
# means @ is left behind at its old position. Move it on top of the content
# commit so main..@ includes it and `jj new`/`jj squash` operations work.
REBASE_COMPLETED=true
if [ -n "$CONTENT_CHANGE" ]; then
  if ! jj new "$CONTENT_CHANGE" 2>/dev/null; then
    log "ERROR: failed to reattach working copy after rebase"
    rollback_after_rebase 1
    exit 1
  fi
fi

# 6. Run the complete host-applicable CI-equivalent gate. It deliberately runs
# in full/default mode here; development-only gate selection and dry-run options
# cannot bypass integration safety.
log "Running full local CI-equivalent gate..."
set +e
python3 -c 'import os; os.setsid(); os.execvp("just", ["just", "ci-local"])' &
GATE_PID=$!
GATE_PGID=$GATE_PID
wait "$GATE_PID"
GATE_STATUS=$?
GATE_PID=""
GATE_PGID=""
set -e
if [ "$GATE_STATUS" -ne 0 ]; then
  log "ERROR: local CI-equivalent gate failed (status $GATE_STATUS) — retained logs are under target/ci-local"
  log "Fix the failing gate, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
  rollback_after_rebase "$GATE_STATUS"
  exit "$GATE_STATUS"
fi

# 7. Advance main bookmark to the latest non-empty commit
TARGET=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | tail -1)
if [ -z "$TARGET" ]; then
  log "ERROR: no non-empty commit found to advance main to — inspect the jj history and workspace commits, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
  release_lock
  RELEASE_ON_EXIT=false
  exit 1
fi
log "Advancing main bookmark to $TARGET..."
BOOKMARK_MOVE_STARTED=true
jj bookmark move main --to "$TARGET" || {
  log "WARN: bookmark move failed — main may have moved. Re-fetching and retrying."
  jj git fetch
  # Recompute REBASE_DEST after fetch (main@origin may have moved)
  REBASE_DEST="main"
  if jj log -r 'main@origin' --no-graph 2>/dev/null | grep -q .; then
    if ! jj log -r 'main@origin & ::main' --no-graph 2>/dev/null | grep -q .; then
      REBASE_DEST="main@origin"
    fi
  fi
  jj rebase -s 'main..@ ~ empty()' -d "$REBASE_DEST" 2>/dev/null || true
  TARGET=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | tail -1)
  if [ -z "$TARGET" ]; then
    log "ERROR: no non-empty commit found after retry — inspect the jj history, fix the bookmark/rebase state, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
    release_lock
    RELEASE_ON_EXIT=false
    exit 1
  fi
  if ! jj bookmark move main --to "$TARGET"; then
    log "ERROR: bookmark move failed after retry — inspect the jj error and main bookmark, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
    release_lock
    RELEASE_ON_EXIT=false
    exit 1
  fi
}

# 8. Push
if [ "${INTEGRATE_DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN: skipping jj git push"
else
  log "Pushing to origin..."
  PUSH_STARTED=true
  if ! jj git push --bookmark main; then
    log "ERROR: push failed — inspect the jj/git error, fix the remote or authentication problem, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
    release_lock
    RELEASE_ON_EXIT=false
    exit 1
  fi
fi

# 9. Close the issue (best-effort)
PUSHED_COMMIT=$(jj log -r "$TARGET" --no-graph -T 'commit_id' 2>/dev/null | head -1 | cut -c1-12)
if [ "${INTEGRATE_DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN: skipping gh issue close"
else
  gh issue close "$ISSUE_NUMBER" --repo TimoFreiberg/pantoken --comment "$(cat <<EOF
<!-- implement-issue -->

Implemented and pushed to main in commit $PUSHED_COMMIT.
EOF
)" 2>/dev/null || log "WARN: failed to close issue #$ISSUE_NUMBER"
fi

# 10. Release lock and exit
log "Successfully integrated issue #$ISSUE_NUMBER to main (commit $PUSHED_COMMIT)"
log "You can now clean up this workspace: just cleanup-current-workspace"
release_lock
RELEASE_ON_EXIT=false
exit 0
