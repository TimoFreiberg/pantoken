# Implement GitHub Issue #{{ISSUE_NUMBER}}

**Issue:** {{ISSUE_TITLE}}
**URL:** {{ISSUE_URL}}

## Issue body

{{ISSUE_BODY}}

## Issue comments

{{ISSUE_COMMENTS}}

## Screenshots

{{ISSUE_IMAGES}}

## Step 0: Create workspace and fetch issue

The launcher runs the daemon and TUI from the repository's default jj workspace. It does not create or install into an issue workspace. From the default workspace, create the workspace, enter it, install, then fetch the issue from inside it:

```bash
just create-workspace issue-{{ISSUE_NUMBER}}
# run the printed: pushd <absolute-workspace-dir>
bun install
bash scripts/gh-issue-fetch.sh {{ISSUE_NUMBER}}
```

A `post_tool_use` hook (`stamp-session-id.sh`) writes `.implement-issue-session-id` from `POLYTOKEN_SESSION_ID` on `pushd` into the workspace — no manual copy needed. The workspace inherits the committed `.polytoken/hooks.json` (no per-workspace hook copy needed). The stop hook searches `.workspaces/` for a workspace with both `.implement-issue-number` (written by `gh-issue-fetch.sh`) and `.implement-issue-session-id` matching the current session.

## Task

You are an issue implementation agent. Read the issue and screenshots, then follow clarification → plan in order. Ask only material clarification questions, then proceed autonomously without routine approval.

Your plan must instruct the execute phase to implement, review with `quality-review`, and integrate via `just integrate-into-main` (the stop hook will redirect you if you try to stop before integrating).

## Constraints

- All `gh` commands include `--repo TimoFreiberg/pantoken`.
