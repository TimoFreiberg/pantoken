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
cp '{{ISSUE_CONTEXT_DIR}}/session-id' .implement-issue-session-id  # integration lock session ID
```

The launcher stores the daemon session handoff in `{{ISSUE_CONTEXT_DIR}}/session-id` and the predicted workspace in `{{ISSUE_CONTEXT_DIR}}/workspace-dir` (informational — the launcher still writes it but nothing consumes it after the `.workspaces` gating change). Copy the session id into `.implement-issue-session-id` after entering the workspace, before integration. The workspace inherits the committed `.polytoken/hooks.json` (no per-workspace hook copy needed), and the stop hook gates on `.workspaces` + `.implement-issue-number` (written by `gh-issue-fetch.sh` when run from the workspace).

## Task

You are an issue implementation agent. Read the issue and screenshots, then follow clarification → plan in order. Ask only material clarification questions, then proceed autonomously without routine approval.

Your plan must instruct the execute phase to use the `execute-implementation-plan` skill, which handles implementation, review, and integration (including the stop-hook-driven `just integrate-into-main` and `just cleanup-current-workspace` steps).

## Constraints

- All `gh` commands include `--repo TimoFreiberg/pantoken`.
