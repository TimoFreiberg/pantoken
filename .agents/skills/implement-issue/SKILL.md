---
name: implement-issue
description: Implement a GitHub issue end-to-end. Clarify, plan, execute, review, and integrate into main.
---

# Implement GitHub Issue #{{ISSUE_NUMBER}}

You are implementing a GitHub issue. Extract the issue number from the invoking prompt.

## Step 0: Fetch and bootstrap the issue workspace

From the repository's **default jj workspace** (the repository root), fetch the issue:

```bash
bash scripts/gh-issue-fetch.sh <issue-number>
```

Read the printed issue and screenshots. The harness does not provide an implementation worktree. Create and enter one now, and do not implement in the default workspace:

```bash
just create-workspace issue-<N>
# run the printed: pushd <absolute-workspace-dir>
bun install
mkdir -p .polytoken
cp scripts/polytoken-config/hooks.json .polytoken/hooks.json
printf '%s\n' '<N>' > .autopilot-issue-number
printf '%s\n' "$PWD/scripts/polytoken-config" > .autopilot-config-dir
printf '%s\n' "$POLYTOKEN_SESSION_ID" > .autopilot-session-id
default_root=$(jj workspace list -T 'name ++ "\t" ++ root ++ "\n"' | awk -F '\t' '$1 == "default" { print $2 }')
printf '%s\n' "$PWD" > "$default_root/.autopilot-workspace-dir"
```

For in-session execution, use the current Polytoken session id from the harness session environment/metadata in `.autopilot-session-id`. If the daemon was started from the default workspace, `.autopilot-workspace-dir` is the explicit handoff that makes the stop hook inspect this issue workspace; `POLYTOKEN_PROJECT_DIR` is authoritative when supplied. Verify all markers and the installed hook before running integration.

## Step 1: Clarify implementation intent

Read the issue and investigate relevant code. Ask focused questions only for material ambiguity. When clarification is complete, continue autonomously without routine approval.

## Step 2: Plan

Investigate the codebase, write and review the plan, and preserve clarification → plan → execute → review ordering.

## Step 3: Execute

Implement the plan. Commit exactly one non-empty implementation commit whose message includes `Fixes #<N>` on its own line after the subject. Do not push directly.

## Step 4: Review implementation

Use the `quality-review` skill, fix or rebut findings, and ensure there is exactly one non-empty commit above `main`.

## Step 5: Integrate and clean up

From the issue workspace, run:

```bash
just integrate-into-main <N>
jj diff --summary
jj log -r 'main..@ ~ empty()' --no-graph
jj diff --from main --to @
just cleanup-current-workspace
popd
```

Cleanup is deliberately refused before integration and will not delete an unintegrated or dirty workspace. Run `popd` only after the current-workspace cleanup script prints `now run popd`.

## Constraints

- All `gh` commands include `--repo TimoFreiberg/pantoken`.
- Do not push directly; use `just integrate-into-main`.
- Keep the commit message's `Fixes #<N>` line and squash all implementation fixes before integration.
