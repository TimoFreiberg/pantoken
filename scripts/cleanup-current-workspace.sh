#!/usr/bin/env bash
# Safely forget and remove the current integrated jj workspace.
set -euo pipefail

[ "$#" -eq 0 ] || { echo "usage: cleanup-current-workspace.sh" >&2; exit 2; }
jj root >/dev/null 2>&1 || { echo "ERROR: run this from a registered jj workspace" >&2; exit 1; }
current_dir=$(pwd -P)
workspace_info=$(jj workspace list -T 'name ++ "\t" ++ root ++ "\n"' 2>/dev/null) || { echo "ERROR: unable to inspect jj workspaces" >&2; exit 1; }
repo_root=""
while IFS=$'\t' read -r name root; do
  [ "$name" = default ] || continue
  repo_root=$(cd "$root" 2>/dev/null && pwd -P || true)
done <<< "$workspace_info"
[ -n "$repo_root" ] || { echo "ERROR: default jj workspace could not be resolved" >&2; exit 1; }
current_name=""
current_root=""
while IFS=$'\t' read -r name root; do
  [ -n "$name" ] || continue
  canonical=$(cd "$root" 2>/dev/null && pwd -P || true)
  if [ "$canonical" = "$current_dir" ]; then current_name=$name; current_root=$canonical; break; fi
done <<< "$workspace_info"
[ -n "$current_name" ] || { echo "ERROR: current directory is not a registered jj workspace" >&2; exit 1; }
[ "$current_root" != "$repo_root" ] || { echo "ERROR: refusing to clean the default workspace" >&2; exit 1; }
workspaces_root=$(cd "$repo_root/.workspaces" 2>/dev/null && pwd -P || true)
[ -n "$workspaces_root" ] || { echo "ERROR: current workspace is outside $repo_root/.workspaces" >&2; exit 1; }
case "$current_root" in "$workspaces_root"/*) ;; *) echo "ERROR: current workspace is outside $workspaces_root" >&2; exit 1;; esac
name_from_path=${current_root#"$workspaces_root/"}
case "$name_from_path" in ""|*/*) echo "ERROR: workspace path is not exactly one .workspaces child" >&2; exit 1;; esac
[ "$name_from_path" = "$current_name" ] || { echo "ERROR: workspace name/path mismatch" >&2; exit 1; }

fail() { echo "ERROR: workspace is not ready for cleanup: $1. Run 'just integrate-into-main <N>' first." >&2; exit 1; }
[ -z "$(jj diff --summary)" ] || fail "working-copy files are dirty"
[ -z "$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null)" ] || fail "non-empty commits remain above main"
[ -z "$(jj diff --from main --to @)" ] || fail "workspace tree differs from main"

jj workspace forget "$current_name"
rm -rf -- "$current_root"
printf 'now run popd\n'
