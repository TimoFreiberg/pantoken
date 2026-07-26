# Implement GitHub Issue #{{ISSUE_NUMBER}}

**Issue:** {{ISSUE_TITLE}}
**URL:** {{ISSUE_URL}}

## Issue body

{{ISSUE_BODY}}

## Issue comments

{{ISSUE_COMMENTS}}

## Screenshots

{{ISSUE_IMAGES}}

## Step 0: Create and enter the implementation workspace

The launcher runs the daemon and TUI from the repository's default jj workspace. It does not create or install into an issue workspace. From the default workspace, run:

```bash
scripts/create-workspace.sh issue-{{ISSUE_NUMBER}}
# run the printed: pushd <absolute-workspace-dir>
bun install
mkdir -p .polytoken
cp scripts/polytoken-config/hooks.json .polytoken/hooks.json
printf '%s\n' '{{ISSUE_NUMBER}}' > .autopilot-issue-number
printf '%s\n' "$PWD/scripts/polytoken-config" > .autopilot-config-dir
cp '{{ISSUE_CONTEXT_DIR}}/session-id' .autopilot-session-id
default_root=$(jj workspace list -T 'name ++ "\t" ++ root ++ "\n"' | awk -F '\t' '$1 == "default" { print $2 }')
printf '%s\n' "$PWD" > "$default_root/.autopilot-workspace-dir"
```

The launcher stores the daemon session handoff in `{{ISSUE_CONTEXT_DIR}}/session-id` and the predicted workspace in `{{ISSUE_CONTEXT_DIR}}/workspace-dir`. Copy the session id after entering the workspace, before integration. When supplied, `POLYTOKEN_PROJECT_DIR` is authoritative; `.autopilot-workspace-dir` tells the stop hook to inspect this issue workspace even though the daemon began in the default workspace. Verify the markers and installed hook.

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
scripts/cleanup-current-workspace.sh
popd
```

Cleanup is deliberately refused before integration. Do not run `popd` until cleanup prints `now run popd`.

## Constraints

- All `gh` commands include `--repo TimoFreiberg/pantoken`.
- Use `just integrate-into-main`, never direct push.
- Squash implementation fixes so there is exactly one non-empty commit above `main` before integrating.
