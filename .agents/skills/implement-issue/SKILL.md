---
name: implement-issue
description: Implement a GitHub issue end-to-end. Starts with the planning step.
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

Investigate the codebase, write and review the plan.
In addition to resolving the github issue, the plan must instruct the execute phase to use the `execute-implementation-plan` skill.

## Step 3: Handoff

Use `handoff_plan` and you're done!

## Constraints

- All `gh` commands include `--repo TimoFreiberg/pantoken`.
