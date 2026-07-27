---
name: implement-issue
description: Implement a GitHub issue end-to-end. Clarify, plan, execute, review, and integrate into main.
---

# Implement GitHub Issue #{{ISSUE_NUMBER}}

You are implementing a GitHub issue. Extract the issue number from the invoking prompt.

## Step 0: Create workspace and fetch issue

From the repository's **default jj workspace** (the repository root), create and enter an issue workspace, then fetch the issue from within it:

```bash
just create-workspace issue-<N>
# run the printed: pushd <absolute-workspace-dir>
bun install
bash scripts/gh-issue-fetch.sh <issue-number>
printf '%s\n' "${POLYTOKEN_SESSION_ID:-}" > .implement-issue-session-id  # optional — integration lock works without it
```

Read the printed issue and screenshots. The workspace inherits the committed `.polytoken/hooks.json` (no per-workspace hook copy needed), and the stop hook gates on `.workspaces` + `.implement-issue-number` (written by `gh-issue-fetch.sh` when run from the workspace). `POLYTOKEN_SESSION_ID` may be unset in some contexts; the integration lock works without it — `integrate-into-main.sh` treats a missing session file as empty.

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
