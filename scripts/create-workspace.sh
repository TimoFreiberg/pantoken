#!/usr/bin/env bash
# Create a jj workspace below the repository root.
set -euo pipefail

usage() { echo "usage: create-workspace.sh <name> [revision]" >&2; exit 2; }
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
name=$1
revision=${2:-main}
case "$name" in
  ""|.|..|/*|*/*|*\\*|*[[:space:]]*|*..*) echo "ERROR: invalid workspace name: $name" >&2; exit 1;;
esac

jj root >/dev/null 2>&1 || { echo "ERROR: run this from a jj workspace" >&2; exit 1; }
current_dir=$(pwd -P)
repo_root=""
is_default=no
while IFS=$'\t' read -r n r; do
  [ -n "$n" ] || continue
  canonical=$(cd "$r" 2>/dev/null && pwd -P || true)
  [ "$n" = default ] && repo_root="$canonical"
  if [ "$canonical" = "$current_dir" ] && [ "$n" = default ]; then is_default=yes; fi
done < <(jj workspace list -T 'name ++ "\t" ++ root ++ "\n"')
[ -n "$repo_root" ] || { echo "ERROR: default jj workspace could not be resolved" >&2; exit 1; }
[ "$is_default" = yes ] || { echo "ERROR: create-workspace.sh must run from the default workspace at $repo_root" >&2; exit 1; }

jj log -r "$revision" --no-graph -T 'commit_id' >/dev/null 2>&1 || { echo "ERROR: invalid revision: $revision" >&2; exit 1; }
workspace_dir="$repo_root/.workspaces/$name"
[ ! -e "$workspace_dir" ] || { echo "ERROR: workspace path already exists: $workspace_dir" >&2; exit 1; }
if jj workspace list -T 'name ++ "\n"' | grep -Fxq "$name"; then echo "ERROR: workspace name already registered: $name" >&2; exit 1; fi
mkdir -p "$repo_root/.workspaces"
jj workspace add "$workspace_dir" --name "$name" --revision "$revision"
printf 'now run `pushd %s`\n' "$workspace_dir"
