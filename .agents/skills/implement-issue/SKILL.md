---
name: implement-issue
description: "Use only when instructed to. Implement a GitHub issue end-to-end: workspace setup, planning, execution, review, and integration into main."
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
```

Read the printed issue and screenshots. 

## Step 1: Clarify implementation intent

Read the issue and investigate relevant code. Ask focused questions only for material ambiguity. When clarification is complete, continue autonomously without routine approval.

## Step 2: Plan

Investigate the codebase, write and review the plan. The plan must instruct the execute phase to:

1. **Implement** the plan faithfully.
2. **Review** using the `quality-review` skill — fix or rebut all findings, loop until clean.
3. **Integrate** — From this point on, a stop hook will guide you. Squash all commits into one, ensure the commit message includes `Fixes #<issue-number>` on its own line, then call `just integrate-into-main <issue-number>`. If it exits 2 (conflicts), resolve them with the `jj-resolve-conflicts` skill and retry. The stop hook will redirect you here if you try to stop before integrating.
4. **Clean up** — after integration succeeds (exit 0), verify with `jj log -r 'main::@'` that you're in an empty commit on top of `main`, then run `just cleanup-current-workspace`.

## Step 3: Handoff

Use `handoff_plan`. The execute phase then drives implementation all the way to integration and cleanup.

## Constraints

- All `gh` commands include `--repo TimoFreiberg/pantoken`.
- Do not push directly; use `just integrate-into-main`.
