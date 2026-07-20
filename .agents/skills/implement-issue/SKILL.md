---
description: Implement a GitHub issue end-to-end. Clarify, plan, execute, review, and integrate into main.
---

# Implement GitHub Issue #{{ISSUE_NUMBER}}

You are implementing a GitHub issue. The issue number is provided in the
prompt that invoked this skill (e.g. `@skill:implement-issue 42`, `#42`, or `https://github.com/User/repo/issues/42`).
Extract the issue number from the prompt; if no number is present, ask the
user which issue to implement before proceeding.

## Step 0: Fetch the issue and bootstrap the worktree

1. Run the fetch script with the issue number to pull the issue body, comments, and screenshots:

   ```bash
   bash scripts/gh-issue-fetch.sh <issue-number>
   ```

   This writes the issue body + comments to a temp `issue.md`, downloads any
   screenshots to a temp `images/` dir, and writes `.implement-issue-number`
   (the marker the stop hook reads). Read the printed paths.

2. **Read the issue.** Read `issue.md` with `file_read`. Read each downloaded
   screenshot with `file_read` (it renders images). Do not re-download or
   re-fetch the issue — everything you need is local now.

3. **Ensure you're in a worktree.** If you're in the base repo of the current
   project, enter a `jj workspace`.

3. **Bootstrap the worktree.** If this session is running in a fresh worktree
   (the `implement-issue` workflow uses `worktree=true`), `node_modules` will
   be absent. Run `bun install` before any build or test command:

   ```bash
   bun install
   ```

## Your task

You are an issue implementation agent. Follow these steps in order. Do NOT
skip steps.

This session has a two-phase interaction contract:

- **Clarification phase:** Before planning or changing code, inspect the issue
  and the relevant product/code context. Identify every material ambiguity
  about intended behavior, scope, UX, compatibility, or acceptance criteria.
  Ask the user focused, answerable implementation questions using the
  `ask_user_question` tool. Group related questions into one interaction where
  practical. Wait for the answers and incorporate them into the plan.
- **Autonomous phase:** Once the material implementation questions have been
  answered — or you have determined that none remain — proceed without asking
  for approval or routine status confirmations. From planning through
  implementation, review, and committing, make reasonable decisions
  autonomously. Ask another user question only if a genuinely new, blocking
  requirement ambiguity is discovered that could not have been identified
  during the clarification phase. This phase ends with the implementation
  commit(s) merging into main.

## Step 1: Clarify implementation intent

1. This phase is read-only.
2. Read the issue and investigate enough of the codebase and product
   conventions to uncover material implementation questions.
3. Use research subagents where applicable to get focused information without
   polluting your context.
4. If questions remain, ask them through the session's user-question
   mechanism, then wait for and apply the user's answers.
5. If no questions remain, continue immediately.

## Step 2: Plan

Write and review the plan only after clarification is complete.

1. You should be in plan facet already. If not, `switch_facet` to plan.
2. Investigate the codebase.
3. Write a plan with `write_plan`.
4. Run the `plan-reviewer` subagent on your plan. Fix or rebut every finding.
   Repeat until there are no critical or high findings.
5. Call `handoff_plan` to hand off to the execute facet.

## Step 3: Execute

After handoff approval:

1. Implement the plan.
3. Commit with `Fixes #<N>` in the commit message (on its own line, after the
   subject). This links the commit to the GitHub issue.

## Step 4: Review implementation

1. Use the `quality-review` skill to review your implementation.
2. Fix or rebut every finding. Repeat the review until clean.
3. Squash all fix commits into the main implementation commit so there is
   exactly one non-empty commit above `main`.

## Step 5: Integrate into main

A stop hook (`check-integration-before-stop`) will guide you on how to integrate
your commit into `main`.

## Constraints

- Do NOT push directly — use `just integrate-into-main`.
- Commit message MUST include `Fixes #<N>`.
- All `gh` commands MUST include `--repo TimoFreiberg/pantoken`.
- Squash all commits into one before integrating.
