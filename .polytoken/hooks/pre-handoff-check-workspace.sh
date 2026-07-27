#!/usr/bin/env bash
# pre-handoff-check-workspace.sh — pre_tool_use hook for handoff_plan.
#
# Fires before handoff_plan hands the plan to execute facet. In an
# implement-issue session, the plan→execute handoff resets the working
# directory to the repo root, so the plan MUST instruct execute to pushd
# back into the issue workspace. If the plan is missing that instruction,
# deny the handoff and tell the agent to add it.
#
# This is a structural guard: it doesn't depend on the agent remembering
# the instruction from the implement-issue skill. The skill's wording is
# the first line of defense; this hook is the backstop.
#
# Environment (set by polytoken):
#   POLYTOKEN_SESSION_ID    The current session's ID.
#   POLYTOKEN_PROJECT_DIR   The session's project directory (the repo root).
#
# Exit codes / stdout:
#   exit 0, no output    → allow (proceed with handoff)
#   exit 2, message      → deny (the model sees the message)
set -euo pipefail

# --- Find the implement-issue workspace for this session ----------------------

REPO_ROOT="${POLYTOKEN_PROJECT_DIR:-}"
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  REPO_ROOT="$PWD"
fi

WORKSPACES_DIR="$REPO_ROOT/.workspaces"
SESSION_ID="${POLYTOKEN_SESSION_ID:-}"

# No session ID or no .workspaces/ → not an implement-issue session, allow.
if [ -z "$SESSION_ID" ] || [ ! -d "$WORKSPACES_DIR" ]; then
  exit 0
fi

# Find the workspace matching this session (same logic as stop-check-integration.sh).
WORKSPACE_DIR=""
if [ -d "$WORKSPACES_DIR" ]; then
  while IFS= read -r -d '' ws_dir; do
    if [ -f "$ws_dir/.implement-issue-number" ] && \
       [ -f "$ws_dir/.implement-issue-session-id" ] && \
       [ "$(cat "$ws_dir/.implement-issue-session-id" 2>/dev/null || true)" = "$SESSION_ID" ]; then
      if [ -n "$WORKSPACE_DIR" ]; then
        # Multiple matches — conservative allow (don't block on ambiguity).
        WORKSPACE_DIR=""
        break
      fi
      WORKSPACE_DIR="$ws_dir"
    fi
  done < <(find "$WORKSPACES_DIR" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
fi

# No matching workspace — not an implement-issue session, allow.
if [ -z "$WORKSPACE_DIR" ]; then
  exit 0
fi

# --- Find the latest plan file -----------------------------------------------

# Sessions live under $XDG_DATA_HOME/polytoken/sessions/<session_id>/.
# Default XDG_DATA_HOME is ~/.local/share.
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
SESSION_DIR="$DATA_HOME/polytoken/sessions/$SESSION_ID"

if [ ! -d "$SESSION_DIR" ]; then
  # Can't find the session dir — allow rather than block on a missing path.
  exit 0
fi

# Find the highest-numbered plan-NNN.md (or plan.md for legacy).
PLAN_FILE=""
for f in "$SESSION_DIR"/plan-*.md "$SESSION_DIR"/plan.md; do
  [ -f "$f" ] || continue
  PLAN_FILE="$f"
done
# plan-*.md sorts lexicographically, and zero-padded numbers sort correctly,
# so the last match is the highest-numbered plan.

if [ -z "$PLAN_FILE" ]; then
  # No plan file found — can't check, allow.
  exit 0
fi

# --- Check the plan for a pushd into the workspace ---------------------------

PLAN_TEXT="$(cat "$PLAN_FILE" 2>/dev/null || true)"
if [ -z "$PLAN_TEXT" ]; then
  exit 0
fi

# Check if the plan mentions the workspace path (absolute or relative) in a
# pushd instruction. We look for "pushd" near the workspace path, or the
# workspace path itself appearing in the plan (the skill instructs recording
# the absolute path as the first implementation step).
#
# We accept either:
#   1. "pushd" + the workspace path (absolute or .workspaces/issue-N)
#   2. The workspace basename (e.g. "issue-109") appearing in a pushd context
#
# Simple check: does the plan contain "pushd" AND the workspace path (or its
# basename)? This is deliberately lenient — we want to catch the case where
# the agent forgot entirely, not enforce exact formatting.

WORKSPACE_BASENAME="$(basename "$WORKSPACE_DIR")"

if echo "$PLAN_TEXT" | grep -qi "pushd" && \
   echo "$PLAN_TEXT" | grep -qF "$WORKSPACE_BASENAME"; then
  # Plan contains a pushd reference to the workspace — allow.
  exit 0
fi

# --- Deny: the plan is missing the workspace entry instruction ----------------

cat <<MSG
The plan is missing a 'pushd' instruction to enter the implement-issue workspace.

This is an implement-issue session with a workspace at:
  $WORKSPACE_DIR

The plan→execute handoff resets the working directory to the repo root, so the
execute agent will NOT be in the workspace unless the plan tells it to pushd
there first. Without this, the agent will edit files in the default workspace,
commits will land in the wrong place, and integration will fail silently.

Fix: add a "Phase 0" or "Step 0" at the very beginning of the plan's
Implementation Plan section that says:

  0. Enter the workspace — \`pushd $WORKSPACE_DIR\`

Then call handoff_plan again.
MSG

exit 2
