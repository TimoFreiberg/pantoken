# Pantoken Autopilot

Autonomously triages open GitHub issues, implements them via a plan→review→handoff→execute loop in a visible Polytoken TUI, and pushes to `main` when the TUI is closed.

## Quick start

```bash
# Dry run (triage only, no implementation):
scripts/autopilot.sh --dry-run

# Full autonomous loop:
scripts/autopilot.sh
```

## How it works

1. **Triage** (headless, `polytoken exec`): lists open issues, skips issues waiting for human input, evaluates implementability, posts clarifying questions on ambiguous issues, picks the simplest implementable one.
2. **Implementation** (TUI, `polytoken attach` in a zellij tab): creates a jj workspace, spawns a headless daemon, seeds it via HTTP (plan facet + adventurous handoff + goal + prompt), and attaches a TUI. The agent runs autonomously — plan→review→handoff→execute→implement→review→commit.
3. **Finalize** (serial, in main loop): fetches latest main, rebases new commits onto `main@origin`, advances the `main` bookmark, pushes.
4. **Cleanup**: forgets the jj workspace, releases the issue claim, loops.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CONCURRENT` | `2` | Max simultaneous implementers (each in its own zellij tab + jj workspace) |

## How to intervene

- **Answer questions**: if the agent calls `ask_user_question`, the TUI blocks until you answer. The zellij tab name shows the issue number for at-a-glance status.
- **Stop an implementation**: close the TUI (Ctrl+C or close the zellij tab). The script will finalize (linearize + push) what was done.
- **Stop the autopilot**: Ctrl+C the main loop. The trap handler kills spawned daemons.

## Crash recovery

### Stale claims

If the script crashes or is killed, claims are left behind. On the next start, `recover_stale_claims` checks whether each claim's daemon PID is still alive (read from `startup.json`). Dead claims are released automatically.

### Orphaned workspaces

If a workspace was left behind (script crashed after TUI close but before cleanup):

```bash
jj workspace list                    # see orphaned autopilot-* workspaces
jj workspace forget autopilot-<N>    # forget the workspace
rm -rf ../pantoken-autopilot-<N>      # remove the directory
```

### Orphaned daemons

If daemons are left running:

```bash
polytoken sessions                   # list active sessions
# Kill orphaned ones manually
```

## Files

```
scripts/autopilot.sh              — entry point (dependency checks, delegates to main.sh)
scripts/autopilot/
  main.sh                         — serial main loop (triage → implement → finalize → cleanup)
  triage-prompt.md                — prompt for the headless triage agent
  parse-triage.sh                 — extracts JSON decision from exec stdout
  seed-session.sh                 — HTTP seeds a headless daemon (facet, handoff, goal, prompt)
  finalize.sh                     — jj linearize + push (fetch, rebase, bookmark move, push)
  claims.sh                       — issue claim/release/stale-recovery (mkdir-based lock)
  README.md                       — this file
  test/
    parse-triage.test.ts          — parser unit tests
    claims.test.ts                — claim management unit tests
    finalize.test.ts              — jj primitive unit tests
```

## Dependencies

- `polytoken` (0.5.0+) — the agent harness
- `jj` — version control
- `gh` — GitHub CLI (authenticated as `TimoFreiberg`)
- `jq` — JSON processing
- `zellij` — terminal multiplexer (for TUI tab management)
- `curl` — HTTP requests to the daemon
