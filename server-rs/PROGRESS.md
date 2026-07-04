# Rust Server Port — Progress Report

Last updated: 2026-07-04

## Goal

Replace the Bun/TS server (`server/`) with a Rust server that implements the same
WS protocol, HTTP endpoints, and driver behavior — validated against the existing
79-spec e2e suite and unit tests. The mock driver becomes a fake daemon speaking the
daemon wire protocol, so one Rust driver implementation serves both real-daemon and
mock modes. The TS server is deleted once the Rust server passes the full e2e suite.

## Current status: Phase 7 (parity validation + cutover) — in progress

### Done (Phases 0–6) ✅

The architecture is complete and verified working.

- **143 unit tests pass** (5 daemon-types + 64 protocol + 74 server) — all green.
- **Server boots**, `/health` responds, WS upgrades, SIGTERM graceful shutdown works.
- All crates build clean (`pilot-protocol`, `pilot-daemon-types`, `pilot-server`).
- Full component port: fold reducer, journal, hub (~35 handleClient cases), driver,
  daemon-client, event-map, history-seed, fake daemon, push service, 7 supporting
  polytoken modules.
- **E2e wiring works**: `PILOT_SERVER_IMPL=rust` spawns the Rust binary via
  `scripts/dev.ts`; Vite proxies to it; the WS pipeline delivers messages end-to-end
  (verified: a real assertion failure on live fixture data, not an infra failure).

### Remaining work (Phase 7) 🔧

**The single dominant blocker is mock fixture fidelity, not architecture.**

#### 1. Mock fixture fidelity (PRIMARY blocker)

The Rust `mock_driver.rs` implements only **4 of 27** TS `SCRIPTS`
(`reply`, `confirm`, `input`, `ambient`), and the `ambient` script's fixture data is
incomplete (missing `work-toggle` transcript blocks).

The `gotoFresh` test helper (used by ~every spec) drives the mock to `ambient`, then
waits for `work-toggle` elements — which never appear. So most tests fail at the
setup step, not at their actual assertions.

**Work needed:**
- Port the fixture data + the 23 missing scripts:
  `answercard, answerleadup, journalnudge, skill, goal, unknown, qna, compat, error,
  bgrun, bgwait, editdiff, idle, initializing, staleidle, pendinghold, timeout,
  yesno, planview, goalactive, goalclear, context`
- Complete the `ambient` script's `work-toggle` blocks
- Add the custom `research` facet (the `facets.e2e` spec expects 3 facets — Execute,
  Plan, Research — but the Rust mock returns only 2)

#### 2. Fix e2e timing/isolation issues

Surfacing issues to fix as they appear once the fixture data is in place.

#### 3. Cutover

- Delete the TS server (`server/`) — or archive under `server-ts-archive/`
- Update `package.json` scripts to point to `cargo`
- Update `AGENTS.md`, `docs/ADR-desktop-shell.md`, `docs/DECISIONS.md`,
  `docs/TODO.md`

### Uncommitted change

`hub.rs` has a one-line uncommitted change: adds `pilot_settings_msg()` to the client
connect sequence (sends pilot settings to clients on connect). It's a parity fix and
looks correct, but is not yet committed.

## How to verify current state

```bash
cd server-rs && cargo build        # builds clean (5 minor warnings)
cd server-rs && cargo test         # 143 tests pass
PILOT_DRIVER=mock PILOT_SERVER_IMPL=rust bun run test:e2e   # runs, mostly fails on fixture data
```

## Key insight

The hard architectural work is done and verified. What remains is mechanical
fixture-data porting — large in volume but low in uncertainty. The path to green e2e
is: port the fixture scripts → fix surfacing timing issues → cutover.
