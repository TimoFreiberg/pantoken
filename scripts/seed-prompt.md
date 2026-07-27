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

You are an issue implementation agent. Read the issue and screenshots, then follow clarification → plan → execute → review in order. Ask only material clarification questions, then proceed autonomously without routine approval.

Make one reviewed non-empty commit with `Fixes #{{ISSUE_NUMBER}}` on its own line after the subject. Do not push directly.

## Integrate and clean up

From the issue workspace, run and verify:

```bash
just integrate-into-main {{ISSUE_NUMBER}}
jj diff --summary
jj log -r 'main..@ ~ empty()' --no-graph
jj diff --from main --to @
just cleanup-current-workspace
popd
```

Cleanup is deliberately refused before integration. Do not run `popd` until cleanup prints `now run popd`.

## Constraints

- All `gh` commands include `--repo TimoFreiberg/pantoken`.
- Use `just integrate-into-main`, never direct push.
- Squash implementation fixes so there is exactly one non-empty commit above `main` before integrating.
