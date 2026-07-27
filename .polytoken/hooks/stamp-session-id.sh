#!/usr/bin/env bash
# stamp-session-id.sh — post_tool_use hook for pushd.
#
# When the agent pushds into a direct child of .workspaces/, stamps the
# workspace with POLYTOKEN_SESSION_ID as .implement-issue-session-id. This
# lets the stop hook find the right workspace for this session, even with
# concurrent implement-issue sessions.
#
# The file is also read by integrate-into-main.sh for same-session lock
# re-acquisition.
#
# Stamps on ANY pushd into .workspaces/, not just implement-issue workspaces,
# because the first pushd (Step 0) happens before gh-issue-fetch.sh writes
# .implement-issue-number. The stamp is a benign hidden file in non-issue
# workspaces.
set -euo pipefail

# Read the pushd target from the event JSON on stdin.
INPUT_JSON="$(cat)"
TARGET_PATH="$(printf '%s' "$INPUT_JSON" | jq -r '.input.path // empty')"

# No path in the event — nothing to do.
[ -z "$TARGET_PATH" ] && exit 0

SESSION_ID="${POLYTOKEN_SESSION_ID:-}"
[ -n "$SESSION_ID" ] || exit 0

# Resolve the repo root from POLYTOKEN_PROJECT_DIR (the daemon pins it to
# the session's project path, not the agent's pushd'd CWD).
REPO_ROOT="${POLYTOKEN_PROJECT_DIR:-}"
[ -z "$REPO_ROOT" ] && exit 0

# Canonicalize both paths to handle relative paths, symlinks, etc.
TARGET_CANON="$(cd "$TARGET_PATH" 2>/dev/null && pwd -P || true)"
REPO_CANON="$(cd "$REPO_ROOT" 2>/dev/null && pwd -P || true)"

[ -z "$TARGET_CANON" ] && exit 0
[ -z "$REPO_CANON" ] && exit 0

# Only stamp if the target is a DIRECT CHILD of $REPO_ROOT/.workspaces/.
# This prevents stamping on nested descendants, unrelated repos, or
# paths that merely contain ".workspaces" as a substring.
WORKSPACES_DIR="$REPO_CANON/.workspaces"
TARGET_PARENT="$(dirname "$TARGET_CANON")"
[ "$TARGET_PARENT" = "$WORKSPACES_DIR" ] || exit 0

# Don't overwrite a different session's ID. Only write if missing or same.
SESSION_FILE="$TARGET_CANON/.implement-issue-session-id"
if [ -f "$SESSION_FILE" ]; then
  EXISTING="$(cat "$SESSION_FILE" 2>/dev/null || true)"
  [ "$EXISTING" = "$SESSION_ID" ] && exit 0
  # Different session owns this workspace — don't hijack it.
  exit 0
fi

# Atomically write the session ID (temp file + mv to avoid readers seeing
# a transient empty file).
TMP_FILE="$TARGET_CANON/.implement-issue-session-id.tmp.$$"
printf '%s\n' "$SESSION_ID" > "$TMP_FILE"
mv -f "$TMP_FILE" "$SESSION_FILE"
