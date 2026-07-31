# Design: Abandon drafts — create a session on `+` (issue #91)

## Goal

Remove pantoken's "new-session draft" concept. Under the new model, clicking
`+` (sidebar top button or a project group's `+` header) creates a **real,
empty session immediately** — spawning the daemon and switching to it — instead
of deferring creation until the first prompt is sent. Sessions the user
abandons without typing anything are **eagerly reaped** (warm cache, sidebar,
and durable state), so stray `+` clicks leave no trace. This eliminates the
entire class of "draft leaks the previous session's state" bugs, of which
issue #91 (stale skills in `@skill:` autocomplete) is one instance.

Two operator-settled scope calls shape this design (2026-07-26):

- **Workspaces leave the GUI entirely.** Workspace isolation is repo tooling's
  job: the `implement-issue` skill enters a `jj workspace` itself
  (`scripts/implement-issue.ts:78` already does `jj workspace add` on the CLI
  path), and polytoken's `pushd`/`popd` tools change the agent's cwd
  in-session. The GUI's worktree toggle, branch picker, and cleanup UI are
  deleted outright (Q1).
- **No deferred-create stage anywhere.** The composer is always bound to a
  real session. Boot-with-no-restore and ⌘N land on a **project chooser view**
  (pure navigation — no composer, no pretend session), not on a landing that
  acts like a session without being one (Q3/Q4).

## Background — why the draft concept exists and what it costs

### What a draft is today

A draft is a **client-only overlay** (`store.draft` in
`client/src/lib/store.svelte.ts:352`) holding: a target `cwd`, a worktree
toggle + base branch, and model/thinking/facet/permission-monitor/
adventurous-handoff picks. The session is only created when the user sends the
first prompt (`submitDraft` → `newSession` message bundling the first prompt).
Drafts are persisted per-project in localStorage (`draftMap` keyed `n:<cwd>`,
`draftConfigMap` for the non-text config), survive reload, and surface as
sidebar rows (`pendingDrafts`).

### The recurring bug class

Because the draft is a client overlay over `store.session` (still the
*previous* session while drafting), every surface that reads `store.session`
sees stale state. Today this is patched with `!store.draft` gates in
`App.svelte` (lines 506–552) that hide the previous session's approvals, plan
view, right context panel, etc. **`startDraft` (line 2441) does not clear
`atRefs` (skills/subagents)** — unlike `openSession` (line 2251, which does) —
so the previous session's skills leak into the draft's `@skill:` autocomplete.
That is issue #91 exactly. `docs/TODO.md` records prior rounds of the same bug
class.

### Why a "just clear atRefs" fix is insufficient

Skills come from a **running daemon's** `GET /state.available_skills`
(`polytoken/driver.rs::list_at_refs`, line 2833). A draft has no session, so
`list_at_refs(None)` returns empty. Files don't have this problem because
drafts use a **server fallback** scoped to the draft cwd (`Composer.svelte:567`,
`drafting` forces fallback). Skills have no fallback — they read `store.atRefs`
directly. So clearing `atRefs` on draft would make `@skill:` *empty* during
draft composition: the wrong-skills bug becomes a no-skills bug. The pivot
removes the draft entirely, so the real session's skills load naturally.

### Scale of the draft concept

~166 references to `.draft`/`store.draft`/`this.draft` across 10 client files
(store.svelte.ts, App.svelte, Composer.svelte, Sidebar.svelte,
StatusHeader.svelte, FacetBadge.svelte, MenuBadge.svelte, QueueTray.svelte,
ModelPicker.svelte, MobileSessionControls.svelte). Plus a persistence layer
(`draftMap`/`draftConfigMap`/`pendingDrafts`/`composerDraftKey` + localStorage)
and an e2e suite (`e2e/drafts.e2e.ts`).

## The central tradeoff: daemon spawns on click — defused by eager reaping

`new_session` (`polytoken/driver.rs:2389`) → `warm_session` (line 1281) →
`spawn_daemon` spawns a **real daemon process immediately**, even if the user
never types. Existing bounds:

- **Warm cap (8, LRU):** `PANTOKEN_WARM_CAP` default 8; creating a 9th evicts
  the least-recently-used warm attachment (`config.rs:142`). Durable session
  state survives eviction — only the live daemon process is reaped.
- **Idle reaper (10 min):** `PANTOKEN_IDLE_REAP_MS` default 600000
  (`config.rs:143`); an untouched session's warm attachment is reaped after
  10 min, durable row persists.

The load-bearing mitigation is new: **eager reaping of empty, default-settings
sessions** (Q5). An abandoned empty session is destroyed outright — warm
daemon, sidebar row, and durable state — so stray `+` clicks leave nothing
behind for the cap or reaper to ever see. The polytoken TUI accepts the
spawn-on-click tradeoff (`docs/DECISIONS.md:39`: "support any feature the
polytoken tui supports"); with eager reaping, pantoken accepts it too and
pays almost nothing for it.

## Resolved design questions

### Q1. Workspaces — removed from the GUI entirely

**Decision:** pantoken no longer creates, displays, or cleans up
workspaces/worktrees. The whole feature is deleted end-to-end:

- **Protocol:** `worktree`/`baseBranch` on `newSession` (`wire.ts:428–439`),
  the `listBranches`/`branchList` request/reply (`wire.ts:510,249`),
  `cleanupWorktree` (`wire.ts:465`), the `worktreeRetained` notice
  (`wire.ts:313`), and `WorktreeInfo` on `SessionListEntry`
  (`session-driver.ts:328–343`). `PROTOCOL_VERSION` (wire.ts:30) bumps 5→6.
- **Server:** the driver-trait methods `cleanup_worktree` (`driver.rs:117`)
  and `list_branches` (`driver.rs:233`), the `worktree`/`base_branch` options
  on `NewSessionOpts` (`driver.rs:22–23`), the hub handlers
  (`hub.rs:1612,1736,1785`), `shared/worktree.rs`, `worktree_store.rs`,
  `worktree_name`, the mock driver's worktree maps
  (`mock_driver.rs:1909–1923`), and the `worktree::create` call in
  `polytoken/driver.rs:2425`.
- **Client:** the Composer worktree chip + branch picker
  (`Composer.svelte:168–180,1728–1745`), store plumbing (`branchList`,
  `queryBranches`, `cleanupWorktree`, the `worktreeRetained` handler, and the
  draft's `worktree`/`baseBranch` fields), the Sidebar worktree glyph +
  context-menu cleanup + copy-path (`Sidebar.svelte:330–339,976–980,
  1109–1135`), the StatusHeader worktree subtitle (`StatusHeader.svelte:
  87–94`), worktree-aware grouping in `session-filter.ts`/`project-menu.ts`,
  and the `worktree` field in `prompt-outbox.ts` (18,108).
- **E2E:** worktree coverage in `composer-chrome.e2e.ts` (~lines 284–460),
  `composer.mobile.e2e.ts` (70–124), `drafts.e2e.ts` (58–91),
  `sessions.e2e.ts` (445–519), `sessions-view.mobile.e2e.ts` (204–207),
  `notice-placement.e2e.ts` (102,139), and `helpers.ts::createWorktreeSession`
  (121–134).

**Why this is right, not just bold:** the worktree toggle was the *only* draft
config field with no live post-create path (worktrees are created during
`new_session`; there is no "convert session to worktree" action). Every other
field has a live `SessionAction` endpoint (`wire.rs:518,528,531,534,507`).
Removing workspaces makes the config model uniform — **everything** is a live
switch on a running session — and deletes the special-case UI that uniformity
would otherwise have to carry (right-click menus, pre-create toggles, branch
pre-fetch).

**Where isolation lives now:** repo tooling. The `implement-issue` skill
already instructs entering a `jj workspace`; the CLI path
(`scripts/implement-issue.ts:78`) runs `jj workspace add` and
`scripts/cleanup-workspace.sh` reaps it. Polytoken's `pushd`/`popd` tools let
any session relocate its agent into a workspace on demand. A session whose
agent entered a workspace keeps its recorded cwd at the base repo — sidebar
grouping, file-mention scoping, and `/debug/state` are unaffected.

**Accepted loss:** historical pantoken-created worktree sessions lose their
sidebar glyph, group-under-base behavior, and the "Clean up worktree…" menu
item. For a single-user tool this is cosmetic; cleanup is
`jj workspace forget` / the repo's cleanup script.

### Q2. Config chips — live session switches (now universal)

Model, thinking, facet, permission-monitor, and adventurous-handoff all become
**live `SessionAction`s on the running session**, applied immediately via the
existing endpoints. This is *cleaner* than today's deferred "apply on create"
logic (`polytoken/driver.rs:2459–2510`, which collects failures as notices
because the journal doesn't exist yet). The chips render from `store.session`
(the real session's reported state) instead of `store.draft`. With workspaces
gone (Q1), there are **no exceptions** — every configurable thing has a live
post-create path.

**Persistence:** per-session composer text already keys `s:<sessionId>`
(`composerDraftKey`, line 675) for live sessions — this path works today and
survives reload. Per-draft config persistence (`n:<cwd>`) is no longer needed:
once the session exists, its config is the daemon's own state, re-fetched on
open. If a "default model/facet per project" preference is still wanted, that
becomes a *preference* layer (applied as the first live action after create),
not a draft-persistence layer.

### Q3. The new-session chooser — one entry view for ⌘N, top `+`, and boot

**Decision:** ⌘N, the top sidebar `+`, and boot-with-no-restore all open a
**dedicated new-session chooser view** — a full-pane view offering only
project-selection affordances: a **recent-projects list** (reuse
`lib/project-menu.ts`'s ranking), a **"Browse…" button** → `DirPicker`, and
nothing else. Picking a project creates the session immediately in that cwd.

**Fast path:** the chooser opens with the **last active project
pre-selected**, so ⌘N, Enter creates a session in the project you were just
in — the common case stays two keystrokes. A different project is one
arrow-down away.

**Project `+` header** (known cwd): creates immediately, no chooser, no
right-click menu (the worktree option it would have held is gone, Q1).

### Q4. Boot landing — the chooser, not a composer

**Decision:** on boot, if a session restores, open it (unchanged). If none
restores, show the **chooser view** (Q3). There is no composer without a
session, no landing-state config object, no bundled-first-prompt create. The
composer is *always* bound to a real session, so the stale-state bug class has
no overlay to live in — this is stronger than the earlier "landing with
scoped state" idea, which kept a miniature draft (config picks taking exactly
one path into a bundled `newSession`) and with it a miniature version of the
same risk.

Boot also never *restores* an empty+default session (Q5): one left behind by
a killed client is reaped on sight rather than reopened.

### Q5. Eager reaping of empty sessions

**Decision:** sessions that are **empty** (no prompt accepted) **and
default-settings** (no live config `SessionAction` applied since creation)
are ephemeral:

- **Navigate away / close:** leaving an empty+default session (switching to
  another session, opening the chooser, quitting) destroys it: the client
  sends a new `destroySession`-style message, the server reaps the warm
  daemon, deletes the durable session state, and broadcasts removal; the
  sidebar row disappears. Stray `+` clicks leave **no trace**.
- **Boot:** restore skips empty+default sessions; the server reaps any it
  finds rather than reopening them (Q4).
- **Warm-cap backstop:** keep a cheap empty-first rule at the cap (evict
  never-prompted sessions before populated ones) so even sessions that escape
  eager reaping churn out before real work. `shared/warm_cap.rs::eviction_plan`
  stays a pure LRU function; the call site (`driver.rs:1175`) does the
  two-pass (empty-only predicate first, plain LRU for the remainder).
- **Idle reaper:** unchanged (10-min bound on anything untouched).

**Race-safety:** the "empty" flag must flip **synchronously on the client at
submit** (before any navigate-away can interleave) and server-side when the
prompt is accepted. A fast send-then-switch must never reap a session whose
first prompt is in flight.

**Net-new server capability:** there is no delete-session path today — only
`setArchived` (`wire.ts:459`). Both drivers need a destroy operation (mock:
trivial, sessions are in-memory fixtures; polytoken: reap the warm attachment
and delete the registry row). **Open implementation question for that phase:**
whether the polytoken daemon exposes session deletion. If it does not, the
fallback is a pantoken-side tombstone (reap the warm attachment, hide the row
from `list_sessions`) — the process is gone and the session is invisible,
which achieves the UX goal; a leftover registry entry on disk is harmless.

**Why not the old empty-first-only plan:** an earlier draft of this design
kept abandoned empty sessions around (durable rows, sidebar entries) and only
prioritized them for warm-cap eviction. The operator rejected that: empty
sessions are noise, not data. Eager reaping is strictly cleaner and makes the
warm-cap rule a backstop instead of the mechanism.

## What gets removed

**Worktree/workspace machinery (phase 1 — the first implementation chunk):**
the full Q1 list above — protocol messages, driver-trait methods, hub
handlers, `shared/worktree*.rs` + `worktree_store.rs`, mock-driver worktree
state, client chip/picker/glyph/menus, and all worktree e2e coverage.

**Draft machinery (later phases):**

- `store.draft` and the entire `draft`/`draftMap`/`draftConfigMap`/
  `pendingDrafts`/`composerDraftKey` (`n:<cwd>`) machinery
  (`store.svelte.ts:330–765`, ~106 references in that file alone).
- `NewSession.svelte` as a draft view (the chooser replaces it; Q3/Q4).
- Sidebar draft rows (`pendingDrafts`, the floating draft row, `discardDraft`).
- The `creatingSession` placeholder + `submitDraft` deferred-create contract
  (replaced by immediate `newSession`).
- The deferred "apply config on create" server logic
  (`polytoken/driver.rs:2459–2510`) — config becomes live `SessionAction`s.
- All `!store.draft` gates in `App.svelte` (lines 506–552) — surfaces read the
  real `store.session` instead of a stale overlay. This is the core payoff.
- `e2e/drafts.e2e.ts` (replaced by new-session-creates-immediately tests).
- The "Draft persistence" decision in `docs/DECISIONS.md:47` — **must be
  revised** to record the pivot and its rationale (kills the stale-state bug
  class; daemon-spawn-on-click accepted, defused by eager reaping).

## Migration path

Phased so each step leaves the app working. Phase 1 is the first
implementation chunk; the rest follow as their own issues.

1. **Remove worktree support end-to-end (Q1).** Pure deletion across
   protocol/server/client/e2e. Independent of the draft pivot, shrinks the
   draft surface (the draft carries `worktree`/`baseBranch` today), and lands
   the protocol 5→6 bump before the noisier refactor.
2. **Destroy-session capability + eager reaping (Q5).** New wire message +
   driver-trait method (mock + polytoken), client reap-on-navigate-away,
   boot-time skip-and-reap, warm-cap empty-first backstop. Must land *before*
   create-on-click so stray clicks never accumulate.
3. **Chooser view + create-on-click (Q3/Q4).** Build the chooser (recent
   projects + Browse…, last-active pre-selected), wire ⌘N/top-`+`/boot to it,
   project `+` header creates immediately. Sessions are real from this phase
   on; the draft still exists underneath until phase 4–5, so land this
   feature-flagged alongside the old path if the diff gets uncomfortable.
   **Status: in progress (phase 3).** The chooser view (`SessionChooser.svelte`)
   replaces the draft entry points; `createSession(cwd)` sends a prompt-less
   `newSession` and transitions to the `creatingSession` warm-up placeholder. The
   draft machinery stays as dead code until phase 5 removes it.
4. **Live config switches (Q2).** Verify the chips issue live `SessionAction`s
   post-create on the immediate-create path (most already work for live
   sessions).
5. **Remove the draft overlay.** Delete `store.draft` + persistence layer +
   sidebar draft rows + `creatingSession` placeholder + `submitDraft`, then
   the `!store.draft` gates in `App.svelte`, then the server-side
   deferred-apply logic (`polytoken/driver.rs:2459–2510`). Verify each
   formerly-gated surface (approvals, plan view, right context panel,
   context-pressure cue) against an empty freshly-created session.
6. **Rewrite e2e.** Replace `e2e/drafts.e2e.ts` with new-session-creates-
   immediately tests (project `+` header, ⌘N chooser fast path, boot landing,
   eager reap on navigate-away, config chips as live switches); update
   `e2e/file-mention.e2e.ts` (the draft-cwd fallback test at line 19 changes
   shape — a fresh empty session *has* a cwd and its skills load via the
   normal `atRefs` push). Make `mock_driver.rs::list_at_refs` session/cwd-aware
   and add the #91 regression test (A→B skills isolation).
7. **Docs.** Revise `docs/DECISIONS.md:47` ("Draft persistence") and add a
   `docs/TODO.md` cross-reference to this design as the structural fix for
   the whole stale-state bug class.

## Acceptance Criteria

These validate the *design* is complete and actionable — no code is written by
this document. Verified by operator review against the codebase.

- **AC.1** The design resolves all five questions (workspaces, config chips,
  chooser, boot landing, eager reaping) with concrete decisions grounded in
  the codebase. Verified by: operator review confirms each decision's
  file:line citations against the repo.
- **AC.2** The design identifies the full removal surface (worktree machinery
  + draft machinery) and the migration phasing. Verified by: operator review
  against a grep of `worktree` and `store.draft`/draft-persistence references.
- **AC.3** The design names the decision it revises (DECISIONS.md "Draft
  persistence", line 47) and the new tradeoff (daemon-on-click, defused by
  eager reaping; warm cap + idle reaper as backstops). Verified by: operator
  review confirms the bounds are real (`config.rs:142,143`).
- **AC.4** The design confirms every remaining config field has a live
  post-create path, with workspaces removed as the one field that didn't.
  Verified by: operator review confirms each field maps to a live
  `SessionAction` endpoint (`wire.rs:518,528,531,534,507`).

## Test Strategy

No code is written by this document; it specifies the test shape each
follow-up phase must satisfy:

- **Phase 1 (worktree removal):** green `bun run check`, `bun test`,
  `just check-rs`, and `bun run test:e2e` with all worktree specs deleted;
  wire-protocol unit tests updated for the 5→6 bump.
- **Phase 2 (eager reap):** Rust unit tests for destroy-session in both
  drivers + the two-pass warm-cap call site; e2e for reap-on-navigate-away
  and boot skip-and-reap; a regression test that a send-then-fast-switch never
  reaps a session whose first prompt is in flight.
- **Phase 6:** the #91 regression e2e (session in project A, `+` a session in
  project B with B-specific skills, `@skill:` shows B's skills) — requires
  making `mock_driver.rs::list_at_refs` session/cwd-aware (today it returns a
  fixed list regardless of session, `mock_driver.rs:2781`).
- **Test-infrastructure gap flagged:** until that mock change lands, #91's
  exact scenario cannot be regression-tested. It is implementation work
  inside phase 6, explicitly called out so it isn't missed.

## Review Strategy

This design doc is reviewed by the operator (author of the "Draft persistence"
decision). Each implementation phase goes through the repo's normal review
(the `quality-review` skill) before integrating.

## Documentation Strategy

- This document is the design record; it lands ahead of the code.
- `docs/DECISIONS.md:47` revision and the `docs/TODO.md` cross-reference land
  in phase 7 (with the code they describe), not here.
- Phase 1 updates `server/PROGRESS.md` where it credits the ported
  worktree modules (lines 70–72,159) and sweeps `docs/` for worktree
  references that become stale.

## Risks, Blockers, and Required Decisions

- **Open question (phase 2): daemon-side session deletion.** Whether the
  polytoken daemon can delete a session from its registry is unverified. If
  not, the pantoken-side tombstone fallback (Q5) achieves the UX goal. This
  must be resolved at the start of phase 2, not discovered mid-refactor.
- **Risk: daemon-spawn churn.** Defused by eager reaping (Q5) — abandoned
  empties are destroyed, not pooled — with warm cap + idle reaper as
  backstops. If churn is still observed in practice, revisit; do *not*
  reintroduce a deferred-create overlay as the fix.
- **Risk: workspaces leave the GUI.** Historical worktree sessions lose
  glyph/grouping/cleanup UI (accepted, Q1). Manual isolation is now
  agent-driven (`pushd` into a `jj workspace`) — a product call the operator
  has made; if it proves painful, the fix belongs in repo tooling, not back
  in the GUI.
- **Risk: large refactor surface.** ~166 draft references + the worktree
  surface. Phasing keeps each step shippable; phase 1 is deliberately the
  simplest (pure deletion) to build momentum and shrink later diffs.
- **Decisions already settled by the operator (2026-07-26):** design-first
  scope; workspaces removed from the GUI entirely; no deferred-create stage
  (composer always bound to a real session); eager reaping of empty+default
  sessions; chooser with last-active project pre-selected.
