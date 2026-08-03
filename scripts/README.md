# Pantoken Scripts

Per-issue clarification-first implementation and autonomous integration tooling.

## Quick start

```bash
# Implement a GitHub issue (spawns a TUI agent in a new zellij tab):
just implement-issue https://github.com/TimoFreiberg/pantoken/issues/42

# Or by number:
just implement-issue 42
```

## How it works

1. **`just implement-issue <url>`** → `scripts/implement-issue.ts`
   - Fetches and validates the issue title/body with `gh --repo TimoFreiberg/pantoken`
   - Extracts image references and, in normal mode, downloads valid images into a unique owned context directory with a manifest
   - Spawns a headless polytoken daemon in the default jj workspace, stores issue context/session handoff data under `.pantoken-issue-context`, and seeds it via authenticated HTTP: bypass_plus permissions, plan facet, adventurous handoff, and the single rendered prompt.
   - Opens a zellij tab from the default workspace and returns immediately; the tab kills the daemon and removes only the owned context. The agent creates, integrates, and cleans its issue workspace.
   - `--dry-run` performs only the read-only issue query; it creates no files, downloads, processes, daemon requests, or workspaces

2. **The agent** (inside the TUI) starts with an interactive clarification phase:
   - Uses the prefetched issue context and local screenshots; it does not refetch them
   - Investigates the issue and asks the user focused implementation questions through the session UI when material ambiguity exists
   - Waits for those answers before planning or changing code

   After clarification, it runs autonomously with no routine approval prompts:
   - Plans → plan-reviewer review → handoff
   - Executes → implements → commits (with `Fixes #N`)
   - Reviews via `quality-review` skill → fixes → squashes
   - Calls `just integrate-into-main <N>` to merge and push
   - Cleans up the workspace via `just cleanup-current-workspace`

3. **`just integrate-into-main <N>`** → `scripts/integrate-into-main.sh`
   - Acquires a repo-local lock (`.merge-lock`, file-based with PID liveness)
   - Fetches latest main, rebases `main..@` onto `main@origin`
   - Verifies exactly one non-empty commit above `main` (squash enforcement)
   - Verifies at least one non-empty commit contains `Fixes #N` in its message
   - Runs `pnpm run test` + `pnpm run check` + `cargo fmt` + `just buck2-clippy` + `just test-rs`
   - Advances the main bookmark, pushes
   - Prints a cleanup hint (`just cleanup-current-workspace`) on success
   - On conflict: exits 2 (lock held), agent resolves and retries
   - Exit codes: 0=success, 2=conflicts, 1=error

## Lock model

The `.merge-lock` file at the repo root serializes integration across
concurrent agents. It's a JSON file with `{pid, session_id, issue_number,
timestamp}`. The lock survives process death (agent shell timeouts) because
it's a file, not an flock.

- **PID alive**: block and wait
- **PID dead, same session**: immediate re-acquire (retry after conflict)
- **PID dead, different session, < 30 min old**: block (likely resolving conflicts)
- **PID dead, different session, ≥ 30 min old**: steal (stale lock)

Manual override: `rm .merge-lock`

## Stop hook: integration guard

Implementer sessions get a dedicated **project-level** stop hook committed to
the repo's `.polytoken/hooks/`. Polytoken discovers project hooks from
`.polytoken/hooks.json` and merges them with global hooks, so every session in
the pantoken repo inherits the user's normal config while still getting the stop
guard. The hook only fires when the session is running inside a `.workspaces/`
subdirectory AND `.implement-issue-number` exists.

The hook (`stop-check-integration.sh`) checks `jj log -r 'main..@ ~ empty()'`
for unpushed commits. If any exist, it returns `continue` with a redirect
to `just integrate-into-main <N>`, preventing the agent from stopping before
integration is complete. A redirect counter (`.implement-issue-stop-redirects`,
capped at 3) prevents infinite loops. After 3 redirects, the agent is allowed
to stop — it will have the integration instructions in its context.

The `.implement-issue-number` marker is written by `gh-issue-fetch.sh` when
run from within a `.workspaces/` subdirectory (the issue workspace).

## Workspace lifecycle

The agent owns the issue workspace lifecycle:

```bash
just create-workspace issue-42 [revision]
# run the printed pushd command, then fetch the issue from within the workspace:
bash scripts/gh-issue-fetch.sh 42
just integrate-into-main 42
just cleanup-current-workspace
# run the printed popd command
```

The creator runs only from the registered default workspace and validates names,
revisions, and collisions. Cleanup runs only from the registered current
workspace directly beneath `.workspaces`; it checks clean files, no non-empty
commits above `main`, and tree equality with `main` before forgetting the
workspace and removing its directory. It prints an actionable integration
message and leaves registration/files intact on failure. Forgetting a workspace
does not delete reachable jj commits; preserve or integrate anything valuable
before cleanup. The old `cleanup-workspace.sh` remains a legacy manual helper.

The launcher stores daemon session handoff data in the owned context. A
`post_tool_use` hook (`stamp-session-id.sh`) fires on `pushd` into a
`.workspaces/` direct child and writes `.implement-issue-session-id` from
`POLYTOKEN_SESSION_ID` — no manual copy needed. After entering the workspace,
fetch the issue with `gh-issue-fetch.sh` (which writes
`.implement-issue-number`). The hooks are inherited from the tracked
`.polytoken/hooks.json` — no per-workspace copy needed.

**Legacy directories:** prior versions used `.workspaces/pantoken-issue-<N>`
as the directory name (mismatching the jj workspace name `issue-<N>`). Those
orphaned dirs are gitignored dev artifacts and are not cleaned by the new
script. Remove them manually if desired:

```bash
rm -rf .workspaces/pantoken-issue-*
```

## Files

```
justfile                          — entry points (implement-issue, integrate-into-main, create-workspace, cleanup-current-workspace, legacy cleanup-workspace)
scripts/
  implement-issue.ts              — typed launcher, context downloader, renderer, and daemon seeder
  implement-issue.sh               — compatibility wrapper for older callers (`exec tsx scripts/implement-issue.ts "$@"`)
  seed-prompt.md                  — the agent's initial prompt template (CLI path)
  create-workspace.sh             — default-workspace-only jj workspace creator
  cleanup-current-workspace.sh     — integrated current-workspace forget + removal
  cleanup-workspace.sh             — legacy name-based manual cleanup helper
  integrate-into-main.sh          — jj linearize + push (lock, fetch, rebase, test, bookmark, push)
  gh-issue-fetch.sh               — fetch issue body + screenshots, write .implement-issue-number marker
  README.md                       — this file
  test/
    integrate-into-main.test.ts   — jj primitive + lock logic tests
    cleanup-workspace.test.ts     — workspace cleanup guard tests (real jj repos)
    stop-check-integration.test.ts — stop hook redirect logic tests
    gh-issue-fetch.test.ts        — issue fetch + marker gating tests
    implement-issue.test.ts       — launcher helper tests
    implement-issue-skill.test.ts — skill/seed-prompt ordering tests
```

## Dependencies

- `polytoken` (0.5.0+) — the agent harness
- `jj` — version control
- `gh` — GitHub CLI (authenticated as `TimoFreiberg`)
- `jq` — JSON processing
- `zellij` — terminal multiplexer (for TUI tab management)
- `just` — command runner
- pnpm + tsx — runs `scripts/implement-issue.ts` and the repository test suite

The launcher owns a unique `issue-*` directory under `.pantoken-issue-context/` during normal execution. It stores `issue-body.md`, downloaded images, `manifest.json`, and daemon session/workspace handoff files; the zellij tab removes that context after the TUI exits. The parent directory is gitignored. Workspace integration and cleanup are performed explicitly by the agent with `just integrate-into-main <N>` and `just cleanup-current-workspace. Screenshot downloads are bounded, content-type checked, and failed downloads are never listed as local screenshots.

`integrate-into-main.sh` exits `0` on success, `2` on conflicts with the lock retained for the resolving session, and `1` for other failures. `INTEGRATE_DRY_RUN=1` skips push and issue close but still exercises the local integration decision path.
