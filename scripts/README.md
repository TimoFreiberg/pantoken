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
   - Creates a jj workspace at `.workspaces/issue-<N>` (matching the jj workspace name), spawns a headless polytoken daemon, and seeds it via authenticated HTTP: bypass_plus permissions, plan facet, adventurous handoff, and the single rendered prompt; the daemon's plan-handoff setting creates the goal at the configured point
   - Opens a zellij tab with the TUI and returns immediately; the tab owns cleanup after the TUI exits: it releases the issue claim, kills the daemon, removes the context directory, and attempts workspace cleanup (forget + rm). If the workspace has unpushed commits or dirty changes, it is retained with a pointer to `just cleanup-workspace <name>`
   - `--dry-run` performs only the read-only issue query; it creates no claims, files, downloads, processes, daemon requests, or workspaces

2. **The agent** (inside the TUI) starts with an interactive clarification phase:
   - Uses the prefetched issue context and local screenshots; it does not refetch them
   - Investigates the issue and asks the user focused implementation questions through the session UI when material ambiguity exists
   - Waits for those answers before planning or changing code

   After clarification, it runs autonomously with no routine approval prompts:
   - Plans → plan-reviewer review → handoff
   - Executes → implements → commits (with `Fixes #N`)
   - Reviews via `quality-review` skill → fixes → squashes
   - Calls `just integrate-into-main <N>` to merge and push

3. **`just integrate-into-main <N>`** → `scripts/integrate-into-main.sh`
   - Acquires a repo-local lock (`.merge-lock`, file-based with PID liveness)
   - Fetches latest main, rebases `main..@` onto `main@origin`
   - Verifies exactly one non-empty commit above `main` (squash enforcement)
   - Verifies at least one non-empty commit contains `Fixes #N` in its message
   - Runs `bun test` + `bun run check` + `cargo fmt`
   - Advances the main bookmark, pushes
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

Implementer sessions get a dedicated **project-level** hook installed into
each issue workspace. Before spawning the daemon, the launcher copies
`scripts/polytoken-config/hooks.json` into `<workspace>/.polytoken/hooks.json`.
Polytoken discovers project hooks from `.polytoken/hooks.json` and merges
them with any global hooks — so the implementer inherits the user's normal
config (models, providers, permissions) while still getting the stop guard.

The hook (`stop-check-integration.sh`) checks `jj log -r 'main..@ ~ empty()'`
for unpushed commits. If any exist, it returns `continue` with a redirect
to `just integrate-into-main <N>`, preventing the agent from stopping before
integration is complete. A redirect counter (`.autopilot-stop-redirects`,
capped at 3) prevents infinite loops. After 3 redirects, the agent is allowed
to stop — it will have the integration instructions in its context.

The launcher writes `.autopilot-issue-number` and `.autopilot-config-dir`
into the workspace so the hook knows which issue is being implemented and
where to find the hook script.

## Workspace cleanup

When the TUI exits, the zellij post-exit cleanup string automatically calls
`scripts/cleanup-workspace.sh` to forget the jj workspace and remove its
directory. The script **guards against data loss**: it refuses to forget a
workspace that has uncommitted working changes or unpushed commits
(`main..@ ~ empty()` is non-empty). In those cases the workspace is retained,
and a message points to the manual recipe:

```bash
just cleanup-workspace issue-42
```

Exit codes: `0` = cleaned up (or already absent), `1` = retained (dirty or
unpushed).

**Legacy directories:** prior versions used `.workspaces/pantoken-issue-<N>`
as the directory name (mismatching the jj workspace name `issue-<N>`). Those
orphaned dirs are gitignored dev artifacts and are not cleaned by the new
script. Remove them manually if desired:

```bash
rm -rf .workspaces/pantoken-issue-*
```

## Files

```
justfile                          — entry points (implement-issue, integrate-into-main, cleanup-workspace)
scripts/
  implement-issue.ts              — typed launcher, context downloader, renderer, and daemon seeder
  implement-issue.sh               — compatibility wrapper (`exec bun run scripts/implement-issue.ts "$@"`)
  seed-prompt.md                  — the agent's initial prompt template
  cleanup-workspace.sh            — guarded jj workspace forget + directory removal
  integrate-into-main.sh          — jj linearize + push (lock, fetch, rebase, test, bookmark, push)
  claims.sh                       — issue claim/release/stale-recovery
  polytoken-config/               — source for the project-level hook (copied into each workspace's .polytoken/)
    hooks.json                    — stop hook that redirects unintegrated agents
    hooks/stop-check-integration.sh — checks for unpushed commits before letting agent stop
  README.md                       — this file
  test/
    integrate-into-main.test.ts   — jj primitive + lock logic tests
    cleanup-workspace.test.ts     — workspace cleanup guard tests (real jj repos)
    claims.test.ts                — claim management tests
    stop-check-integration.test.ts — stop hook redirect logic tests
```

## Dependencies

- `polytoken` (0.5.0+) — the agent harness
- `jj` — version control
- `gh` — GitHub CLI (authenticated as `TimoFreiberg`)
- `jq` — JSON processing
- `zellij` — terminal multiplexer (for TUI tab management)
- `just` — command runner
- Bun — runs `scripts/implement-issue.ts` and the repository test suite

The launcher owns a unique `issue-*` directory under `.pantoken-issue-context/` during normal execution. It stores `issue-body.md`, downloaded images, and `manifest.json`; the zellij tab removes that context after the TUI exits. The parent directory is gitignored. When the TUI exits, the workspace is automatically cleaned up (forget + rm) if integration is complete; if unpushed commits or dirty changes remain, the workspace is retained and `just cleanup-workspace <name>` removes it later. Screenshot downloads are bounded, content-type checked, and failed downloads are never listed as local screenshots.

`integrate-into-main.sh` exits `0` on success, `2` on conflicts with the lock retained for the resolving session, and `1` for other failures. `INTEGRATE_DRY_RUN=1` skips push and issue close but still exercises the local integration decision path.
