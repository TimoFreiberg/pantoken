#!/usr/bin/env bash
# main.sh — autonomous GitHub issue implementation loop.
#
# Continuously triages open GitHub issues, picks implementable ones, runs a
# plan→review→handoff→implement→review loop in a visible Polytoken TUI (with
# adventurous handoff), and when the TUI closes, linearizes jj history onto
# main and pushes. Issues needing human input get a comment and are skipped.
# Supports up to MAX_CONCURRENT concurrent implementers.
#
# Usage: main.sh [--dry-run]
#   --dry-run  Run triage only, print the decision, and exit (no implementation)
#
# Environment:
#   MAX_CONCURRENT  Max simultaneous implementers (default: 2)
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────

MAX_CONCURRENT="${MAX_CONCURRENT:-2}"
REPO_ROOT="/Users/timo/src/pantoken"
SCRIPT_DIR="$REPO_ROOT/scripts/autopilot"
DRY_RUN=false
MARKER_DIR="$HOME/.local/share/pantoken-autopilot"

[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

# ─── Logging ─────────────────────────────────────────────────────────────────

# Timestamp prefix for log lines (HH:MM:SS)
ts() { date '+%H:%M:%S'; }

# Log a message to stderr with a timestamp prefix
log() { echo "[$(ts)] $*" >&2; }

# ─── Source helpers ──────────────────────────────────────────────────────────

# shellcheck source=claims.sh
source "$SCRIPT_DIR/claims.sh"

init_claims

# Track spawned daemon PIDs for cleanup on exit
SPAWNED_DAEMON_PIDS=()

# Track background implementation subshell PIDs so we can kill them on exit.
# Without this, Ctrl+C kills the main loop but the background subshells
# (and their zellij tabs + daemons) keep running as orphans.
BG_PIDS=()

# ─── Signal handling ─────────────────────────────────────────────────────────

cleanup_on_exit() {
  log ""
  log "Autopilot shutting down..."

  # Kill background implementation subshells first (they hold zellij tabs open)
  for pid in "${BG_PIDS[@]:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "Killing implementation subshell PID $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done

  # Kill any daemons we spawned
  for pid in "${SPAWNED_DAEMON_PIDS[@]:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "Killing daemon PID $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done

  log "Done."
}

trap cleanup_on_exit EXIT
trap 'log ""; exit 130' INT TERM

# ─── Functions ───────────────────────────────────────────────────────────────

# Run a single implementation in a background subshell.
# Creates a jj workspace, spawns a headless daemon, seeds it, attaches TUI
# in a zellij tab. Blocks (in the subshell) until the TUI closes.
run_implementation() {
  local issue_number=$1 issue_url=$2 issue_title=$3 slot=$4

  # 1. Create worktree.
  # If a workspace directory already exists, it's from a crashed run —
  # but we can only safely remove it if no daemon is active for this issue.
  # The is_issue_claimed check in the main loop should have prevented us
  # from getting here for an active issue, so this is just a safety net.
  cd "$REPO_ROOT"
  if [ -d "$REPO_ROOT/../pantoken-autopilot-$issue_number" ]; then
    log "WARN: workspace dir for issue #$issue_number still exists — cleaning up stale workspace"
    jj workspace forget "autopilot-$issue_number" 2>/dev/null || true
    rm -rf "$REPO_ROOT/../pantoken-autopilot-$issue_number"
  fi
  jj workspace add "../pantoken-autopilot-$issue_number" \
    --name "autopilot-$issue_number" || {
    log "ERROR: failed to create workspace for issue #$issue_number"
    return 1
  }
  cd "$REPO_ROOT/../pantoken-autopilot-$issue_number"
  bun install

  # 2. Spawn daemon headless
  local daemon_out session_id port
  daemon_out=$(polytoken new --no-attach)
  # Parse with sed (BSD grep on macOS has no -P flag)
  session_id=$(echo "$daemon_out" | sed -n 's/.*session_id=\([^ ]*\).*/\1/p')
  port=$(echo "$daemon_out" | sed -n 's/.*port=\([0-9]*\).*/\1/p')

  if [ -z "$session_id" ] || [ -z "$port" ]; then
    log "ERROR: failed to parse daemon output: $daemon_out"
    return 1
  fi

  # Track the daemon PID for cleanup
  local startup_file
  startup_file="$HOME/.local/share/polytoken/sessions/$session_id/startup.json"
  local daemon_pid=""
  if [ -f "$startup_file" ]; then
    daemon_pid=$(jq -r '.pid // empty' "$startup_file" 2>/dev/null || true)
    if [ -n "$daemon_pid" ]; then
      SPAWNED_DAEMON_PIDS+=("$daemon_pid")
    fi
  fi

  # Update claim with session_id
  update_claim_session "$issue_number" "$session_id"

  # 3. Seed the session via HTTP (waits for daemon readiness internally)
  "$SCRIPT_DIR/seed-session.sh" "$session_id" "$port" "$issue_url" "$issue_title"

  # 4. Attach TUI in a zellij tab (blocks until TUI closes)
  zellij action new-tab --block-until-exit \
    --cwd "$REPO_ROOT/../pantoken-autopilot-$issue_number" \
    --name "#$issue_number" \
    -- polytoken attach "$session_id"

  # When we get here, the TUI has been closed.
  # The merge + push + cleanup happens in the main loop (serial).
}

# Wait for any implementation slot to finish (done-* or failed-* marker file)
wait_for_slot_to_finish() {
  while true; do
    for slot in $(seq 0 $((MAX_CONCURRENT - 1))); do
      if [ -f "$MARKER_DIR/done-$slot" ]; then
        echo "$slot"
        return
      fi
      if [ -f "$MARKER_DIR/failed-$slot" ]; then
        echo "$slot"
        return
      fi
    done
    sleep 5
  done
}

# Merge, push, and clean up a finished implementation slot.
merge_and_cleanup_finished_slot() {
  local slot=$1
  local status="failed"
  if [ -f "$MARKER_DIR/done-$slot" ]; then
    status="done"
  fi
  rm -f "$MARKER_DIR/done-$slot" "$MARKER_DIR/failed-$slot"

  local issue_number
  issue_number=$(get_claim_issue "$slot")

  if [ -z "$issue_number" ] || [ "$issue_number" = "null" ]; then
    log "WARN: no claim found for slot $slot — skipping"
    return 0
  fi

  # If implementation failed, skip finalize — just clean up and release.
  if [ "$status" = "failed" ]; then
    log "Implementation failed for issue #$issue_number — skipping finalize"
    cd "$REPO_ROOT"
    jj workspace forget "autopilot-$issue_number" 2>/dev/null || true
    rm -rf "$REPO_ROOT/../pantoken-autopilot-$issue_number"
    release_claim "$issue_number"
    return 1
  fi

  # Finalize: linearize + push (serial — no flock needed, runs in main loop)
  cd "$REPO_ROOT/../pantoken-autopilot-$issue_number"
  if ! "$SCRIPT_DIR/finalize.sh" "$issue_number"; then
    log "Finalize failed — leaving workspace intact for manual resolution"
    cd "$REPO_ROOT"
    release_claim "$issue_number"
    return 1
  fi

  # Cleanup (only on success)
  cd "$REPO_ROOT"
  jj workspace forget "autopilot-$issue_number" 2>/dev/null || true
  rm -rf "$REPO_ROOT/../pantoken-autopilot-$issue_number"
  release_claim "$issue_number"
}

# ─── Main Loop ───────────────────────────────────────────────────────────────

# Clean up stale marker files from a previous crashed run
rm -f "$MARKER_DIR"/done-* "$MARKER_DIR"/failed-* 2>/dev/null || true

while true; do
  log "─── Triage cycle ───"

  # 1. Recover stale claims
  recover_stale_claims

  # 2. Count active slots
  ACTIVE_SLOTS=$(count_active_slots)
  FREE_SLOTS=$((MAX_CONCURRENT - ACTIVE_SLOTS))

  log "Active: $ACTIVE_SLOTS/$MAX_CONCURRENT slots, $FREE_SLOTS free"

  if [ "$FREE_SLOTS" -le 0 ]; then
    # All slots busy — wait for one to finish, then merge + cleanup
    FINISHED_SLOT=$(wait_for_slot_to_finish)
    merge_and_cleanup_finished_slot "$FINISHED_SLOT" || true
    continue
  fi

  # 3. Triage (serial, headless)
  # Build the triage prompt with currently-claimed issues injected.
  # We avoid sed for the substitution because BSD sed (macOS) errors on
  # unescaped newlines in the replacement pattern. Instead, we read the
  # prompt file, replace the placeholder line with awk, and capture the
  # result. awk handles multi-line replacements natively.
  CLAIMED=$(list_claimed_issues)
  if [ -z "$CLAIMED" ]; then
    CLAIMED_LIST="(none)"
  else
    # Format as a bulleted list
    CLAIMED_LIST=""
    for num in $CLAIMED; do
      CLAIMED_LIST="${CLAIMED_LIST}- #${num}
"
    done
  fi

  # Use awk to replace the placeholder line with the claimed-issues list.
  # We pass the replacement via ENVIRON (not -v) because BSD awk (macOS)
  # can't handle newlines in -v values. ENVIRON handles them fine.
  export CLAIMED_LIST
  TRIAGE_PROMPT=$(awk '
    $0 == "CLAIMED_ISSUES_PLACEHOLDER" { print ENVIRON["CLAIMED_LIST"]; next }
    { print }
  ' "$SCRIPT_DIR/triage-prompt.md") || {
    log "ERROR: failed to build triage prompt"
    TRIAGE_OUTPUT='{"status":"error"}'
    STATUS="error"
  }

  if [ "${STATUS:-}" != "error" ]; then
  TRIAGE_OUTPUT=$(cd "$REPO_ROOT" && polytoken exec --facet plan --max-tool-turns 15 \
    "$TRIAGE_PROMPT" \
    | "$SCRIPT_DIR/parse-triage.sh" 2>/dev/null || echo '{"status":"error"}')
  fi

  STATUS=$(echo "$TRIAGE_OUTPUT" | jq -r '.status')

  if [ "$STATUS" = "no_work" ] || [ "$STATUS" = "error" ]; then
    log "No implementable issues found (status: $STATUS)"
    # If slots are active, wait for one to finish; else sleep
    if [ "$ACTIVE_SLOTS" -gt 0 ]; then
      FINISHED_SLOT=$(wait_for_slot_to_finish)
      merge_and_cleanup_finished_slot "$FINISHED_SLOT" || true
    else
      sleep 60
    fi
    continue
  fi

  if [ "$STATUS" = "implementable" ]; then
    ISSUE_NUMBER=$(echo "$TRIAGE_OUTPUT" | jq -r '.issue_number')
    ISSUE_URL=$(echo "$TRIAGE_OUTPUT" | jq -r '.issue_url')
    ISSUE_TITLE=$(echo "$TRIAGE_OUTPUT" | jq -r '.title')

    log "Triage picked issue #$ISSUE_NUMBER: $ISSUE_TITLE"

    # Defensive check: skip if already claimed (triage agent may have ignored
    # the claimed-issues list in the prompt)
    if is_issue_claimed "$ISSUE_NUMBER"; then
      log "Issue #$ISSUE_NUMBER is already claimed — skipping (triage should have filtered this)"
      if [ "$ACTIVE_SLOTS" -gt 0 ]; then
        FINISHED_SLOT=$(wait_for_slot_to_finish)
        merge_and_cleanup_finished_slot "$FINISHED_SLOT" || true
      else
        sleep 30
      fi
      continue
    fi

    # In dry-run mode, print the triage decision and exit
    if [ "$DRY_RUN" = true ]; then
      log "DRY RUN: would implement issue #$ISSUE_NUMBER — $ISSUE_TITLE"
      log "  URL: $ISSUE_URL"
      exit 0
    fi

    # Find the lowest free slot index
    SLOT=$(find_free_slot)
    if [ "$SLOT" = "-1" ]; then
      log "ERROR: no free slot found despite FREE_SLOTS > 0 — waiting"
      FINISHED_SLOT=$(wait_for_slot_to_finish)
      merge_and_cleanup_finished_slot "$FINISHED_SLOT" || true
      continue
    fi

    # Claim the issue (serial — no race)
    claim_issue "$ISSUE_NUMBER" "$SLOT"

    # Kick off implementation in a background process.
    # Track the PID so cleanup_on_exit can kill it on Ctrl+C.
    (
      if run_implementation "$ISSUE_NUMBER" "$ISSUE_URL" "$ISSUE_TITLE" "$SLOT"; then
        touch "$MARKER_DIR/done-$SLOT"
      else
        touch "$MARKER_DIR/failed-$SLOT"
      fi
    ) &
    BG_PIDS+=("$!")
  fi
done
