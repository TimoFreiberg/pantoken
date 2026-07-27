#!/usr/bin/env bash
# stop-check-integration.sh — stop hook for implement-issue sessions.
#
# Fires when the agent would finish. If there are non-empty commits above
# main that have NOT been pushed (integrated), the hook returns "continue"
# with a redirect to `just integrate-into-main`, so the agent runs the
# integration step instead of stopping prematurely.
#
# To prevent infinite loops, a redirect counter caps at MAX_REDIRECTS (3).
# After that the hook lets the agent stop with a warning.
#
# This hook is committed to the repo's .polytoken/ and fires on every stop in
# every session in the pantoken repo. It no-ops unless it finds an
# implement-issue workspace under $POLYTOKEN_PROJECT_DIR/.workspaces/ that
# belongs to THIS session (matched via .implement-issue-session-id).
#
# Environment (set by polytoken):
#   POLYTOKEN_PROJECT_DIR   The session's project directory (the repo root).
#   POLYTOKEN_SESSION_ID    The current session's ID.
#
# Workspace files (written by gh-issue-fetch.sh / stamp-session-id.sh):
#   .implement-issue-number         The issue number being implemented.
#   .implement-issue-session-id     The session ID that owns this workspace.
#   .implement-issue-stop-redirects Redirect counter (caps infinite loops).
#
# Exit codes / stdout:
#   exit 0, no output    → stop (let the model finish)
#   exit 0, JSON on stdout → continue (with reason the model sees)
set -euo pipefail

MAX_REDIRECTS=3

# POLYTOKEN_PROJECT_DIR is the repo root (the daemon pins it to the session's
# project path, not the agent's pushd'd CWD). Search .workspaces/ for the
# implement-issue workspace belonging to this session.
REPO_ROOT="${POLYTOKEN_PROJECT_DIR:-}"
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  REPO_ROOT="$PWD"
fi

WORKSPACES_DIR="$REPO_ROOT/.workspaces"

# Find the workspace for this session.
# Strategy:
#   1. Scan .workspaces/*/ for .implement-issue-number markers.
#   2. If none found → not an implement-issue session, exit 0.
#   3. If one or more found → match .implement-issue-session-id against
#      POLYTOKEN_SESSION_ID. Exactly one match → use it. Zero matches →
#      exit 0 (this session's workspace hasn't been stamped yet, or this
#      isn't an implement-issue session). Multiple matches → exit 0
#      (shouldn't happen; conservative no-op).
#
# We NEVER select a workspace without a session-ID match. This prevents a
# non-implement-issue session from being redirected by a stale workspace,
# and prevents cross-session capture.
PROJECT_DIR=""
SESSION_ID="${POLYTOKEN_SESSION_ID:-}"

if [ -d "$WORKSPACES_DIR" ] && [ -n "$SESSION_ID" ]; then
  while IFS= read -r -d '' ws_dir; do
    if [ -f "$ws_dir/.implement-issue-number" ] && \
       [ -f "$ws_dir/.implement-issue-session-id" ] && \
       [ "$(cat "$ws_dir/.implement-issue-session-id" 2>/dev/null || true)" = "$SESSION_ID" ]; then
      if [ -n "$PROJECT_DIR" ]; then
        # Multiple matches — conservative no-op.
        PROJECT_DIR=""
        break
      fi
      PROJECT_DIR="$ws_dir"
    fi
  done < <(find "$WORKSPACES_DIR" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
fi

# No matching workspace — not an implement-issue session, let it stop.
if [ -z "$PROJECT_DIR" ]; then
  exit 0
fi

REDIRECT_FILE="$PROJECT_DIR/.implement-issue-stop-redirects"

issue_number=""
if [ -f "$PROJECT_DIR/.implement-issue-number" ]; then
  issue_number=$(cat "$PROJECT_DIR/.implement-issue-number" 2>/dev/null || true)
fi

# Validate the issue number is a positive integer.
if ! [[ "$issue_number" =~ ^[1-9][0-9]*$ ]]; then
  exit 0
fi

# .implement-issue-session-id is written by stamp-session-id.sh (post_tool_use
# hook on pushd). This hook only READS it for matching; it never writes it.

# Check for non-empty commits above main that need integration.
# CRITICAL: jj log must run in the selected workspace, not the hook's CWD
# (which is the repo root). The hook process CWD is the repo root; jj log
# without cd would check the wrong working copy.
non_empty=$(cd "$PROJECT_DIR" && jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | head -1 || true)

# No unpushed commits — integration is complete (or never started).
# Either way, let the agent stop.
if [ -z "$non_empty" ]; then
  rm -f "$REDIRECT_FILE" 2>/dev/null || true
  exit 0
fi

# There are unpushed commits. Count redirects to avoid infinite loops.
redirect_count=0
if [ -f "$REDIRECT_FILE" ]; then
  redirect_count=$(cat "$REDIRECT_FILE" 2>/dev/null || echo 0)
fi

if [ "$redirect_count" -ge "$MAX_REDIRECTS" ]; then
  # Exhausted redirects — let the agent stop, but warn.
  rm -f "$REDIRECT_FILE" 2>/dev/null || true
  cat <<'JSON'
{"outcome":"stop"}
JSON
  exit 0
fi

# Increment redirect counter.
echo $((redirect_count + 1)) > "$REDIRECT_FILE"

# Return continue with a redirect message the agent will see.
# Includes the absolute workspace path so the agent can re-enter it.
cat <<JSON
{"outcome":"continue","reason":"You have NOT yet integrated your work into main. There are unpushed commits above main. First re-enter your workspace:\n\npushd ${PROJECT_DIR}\n\nThen ensure your commit message includes exactly 'Fixes #${issue_number}' on its own line after the subject. Run the integration command now:\n\njust integrate-into-main ${issue_number}\n\nThis acquires a lock, rebases onto latest main, runs tests, and pushes. If it exits 2 (conflicts), resolve them with the jj-resolve-conflicts skill and retry. Do not stop until integration succeeds (exit 0) or you have posted a comment explaining a blocking failure."}
JSON
