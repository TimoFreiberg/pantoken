#!/usr/bin/env bash
# cleanup-workspace.sh — forget a jj workspace and remove its directory.
#
# Guards: refuses to forget if the workspace has uncommitted working changes or
# unpushed commits (main..@ ~ empty() is non-empty). This protects work that
# hasn't been integrated yet.
#
# Usage: cleanup-workspace.sh <workspace-name>
# Exit codes: 0=cleaned up (or already absent), 1=retained (dirty or unpushed)
set -euo pipefail

WS_NAME="${1:?usage: cleanup-workspace.sh <workspace-name>}"
REPO_ROOT="${PANTOKEN_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
WS_DIR="$REPO_ROOT/.workspaces/$WS_NAME"

log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

# 1. If the workspace isn't tracked by jj, just remove the dir if it lingers.
if ! jj -R "$REPO_ROOT" workspace list -T 'name ++ "\n"' 2>/dev/null | grep -Fqx "$WS_NAME"; then
  if [ -d "$WS_DIR" ]; then
    rm -rf "$WS_DIR"
    log "Removed untracked workspace directory: $WS_DIR"
  else
    log "Workspace '$WS_NAME' not found — nothing to do."
  fi
  exit 0
fi

# 2. Refuse if working changes are dirty.
DIRTY=$(jj -R "$WS_DIR" diff --summary 2>/dev/null | head -1 || true)
if [ -n "$DIRTY" ]; then
  log "Workspace '$WS_NAME' has uncommitted changes — retaining."
  log "Commit or abandon changes, then rerun: just cleanup-workspace $WS_NAME"
  exit 1
fi

# 3. Refuse if there are unpushed commits above main.
UNPUSHED=$(jj -R "$WS_DIR" log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | head -1 || true)
if [ -n "$UNPUSHED" ]; then
  log "Workspace '$WS_NAME' has unpushed commits — retaining."
  log "Run 'just integrate-into-main' or push manually, then: just cleanup-workspace $WS_NAME"
  exit 1
fi

# 4. Forget and remove.
jj -R "$REPO_ROOT" workspace forget "$WS_NAME"
rm -rf "$WS_DIR"
log "Cleaned up workspace '$WS_NAME' ($WS_DIR)."
exit 0
