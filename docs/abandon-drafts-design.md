# Design: Abandon drafts — create a session on `+` (issue #91)

## Goal

Produce a design + migration plan for removing pantoken's "new-session draft"
concept, **committed to the repo at `docs/abandon-drafts-design.md`**. Under the
new model, clicking `+` (sidebar top button, a project group's `+` header) or
pressing ⌘N creates a real, empty session immediately — spawning the daemon and
switching to it — instead of deferring creation until the first prompt is sent.
This eliminates the entire class of "draft leaks the previous session's state"
bugs, of which issue #91 (stale skills in `@skill:` autocomplete) is one instance.

> **Scope of "immediately":** the `+`/⌘N entry points create on click (daemon
> spawns). The *boot* path is deliberately lighter — when no session restores,
> a landing state defers creation to first interaction rather than spawning a
> daemon at cold start. See Q4. This split (immediate on explicit action,
> deferred on passive boot) is an explicit design decision, not a contradiction.

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
That is issue #91 exactly. `docs/TODO.md:59` records a prior round of the same
bug class.

### Why a "just clear atRefs" fix is insufficient

Skills come from a **running daemon's** `GET /state.available_skills`
(`polytoken/driver.rs::list_at_refs`, line 2833). A draft has no session, so
`list_at_refs(None)` returns empty. Files don't have this problem because drafts
use a **server fallback** scoped to the draft cwd (`Composer.svelte:567`,
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

## The central tradeoff: daemon spawns on click

`new_session` (`polytoken/driver.rs:2389`) → `warm_session` (line 1281) →
`spawn_daemon` spawns a **real daemon process immediately**, even if the user
never types. Existing mitigations:

- **Warm cap (8, LRU):** `PANTOKEN_WARM_CAP` default 8; creating a 9th evicts
  the least-recently-used warm attachment (`config.rs:142`). Durable session
  state survives eviction — only the live daemon process is reaped.
- **Idle reaper (10 min):** `PANTOKEN_IDLE_REAP_MS` default 600000
  (`config.rs:143`); an untouched session's warm attachment is reaped after
  10 min, durable row persists.

So the cost is bounded: stray `+` clicks leave daemon processes for up to 10
minutes and churn the warm pool. The polytoken TUI accepts this tradeoff
(`docs/DECISIONS.md:39`: "support any feature the polytoken tui supports").
This design accepts it too — and adds an **empty-first eviction** rule (Q5
below) so the churn cost lands on throwaway empty sessions, not real work.

## Resolved design questions

### Q1. Worktree toggle — must be decided pre-creation

**Finding:** worktrees are created *during* `new_session` server-side
(`polytoken/driver.rs:2425`, `worktree::create`). There is **no live "convert
session to worktree" action** — the daemon is already running in the base cwd by
the time the session exists. All other draft config fields (model, thinking,
facet, permission-monitor, adventurous-handoff) **do** have live `SessionAction`
endpoints (`SetModel`, `SetThinking`, `SetFacet`, `SetPermissionMonitor`,
`ToggleAdventurousHandoff` — `wire.rs:518,528,531,534,507`), so they can become
live switches on the running session.

**Decision:** The worktree choice is made **before** the session is created, in
the pre-create chooser (Q3). Two entry shapes:

- **Project `+` header** (known cwd): a **left-click creates a plain session
  immediately**; the worktree option lives behind a **right-click context menu**
  on the same `+` button ("New worktree session in `<repo>`"). This keeps the
  common one-tap default fast (no inline choice to trip over) while making
  worktree discoverable via the same right-click pattern the sidebar already
  uses on session rows (`Sidebar.svelte:947`, `openMenu`). The context menu is
  the "easiest obvious fix" for the worktree special case per the operator.
- **⌘N / top `+`** (chooser): the dedicated new-session chooser view (Q3)
  includes a worktree toggle, in the same way the current draft chip does.

**Alternative considered (rejected):** an inline "New / New worktree" choice
revealed on left-click of the project `+`. Rejected — it adds a tap to the
common path; right-click keeps the default one-tap and co-locates worktree
where power-users already look (the existing context-menu pattern).

**Future note (out of scope here):** polytoken has a `pushd`/`popd` tool, so
worktree-style isolation *could* eventually be created in-session rather than
pre-creation. That path isn't baked yet; the right-click pre-create worktree is
the interim fix. A later issue can explore in-session workspace creation.

**Migration note:** the worktree base-branch picker (`branchList` /
`queryBranches`) currently pre-fetches on `startDraft` (`store.svelte.ts:2490`).
Under the pivot it pre-fetches when the worktree toggle is selected in the
pre-create chooser, before the create call.

### Q2. Config chips — become live session switches

**Decision:** Model, thinking, facet, permission-monitor, and
adventurous-handoff all become **live `SessionAction`s on the running session**,
applied immediately via the existing endpoints. This is *cleaner* than today's
deferred "apply on create" logic (`polytoken/driver.rs:2459–2510`, which
collects failures as notices because the journal doesn't exist yet). The chips
render from `store.session` (the real session's reported state) instead of
`store.draft`.

**Persistence:** per-session composer text already keys `s:<sessionId>`
(`composerDraftKey`, line 675) for live sessions — this path already works and
survives reload. Config overrides that were persisted per-draft (`n:<cwd>`) are
no longer needed: once the session exists, its config is the daemon's own state,
re-fetched on open. If a "default model/facet per project" preference is still
wanted, that becomes a *preference* layer (applied as the first live action
after create), not a draft-persistence layer.

### Q3. ⌘N / top `+` — a dedicated new-session chooser view

**Finding:** `ProjectMenu.svelte` exists today as a dropdown overlay (lists known
projects ranked by recency + "New project…" → `DirPicker`), opened from the
draft's project chip (`Composer.svelte:1716`, `draft-project-control`).

**Decision:** ⌘N and the top sidebar `+` open a **dedicated new-session chooser
view** — a full-pane view (not a dropdown) that offers only project-selection
affordances: a **recent-projects list** (reuse `lib/project-menu.ts`'s ranking),
a **"Browse…" button** → `DirPicker`, and a **worktree toggle** (Q1). Picking a
project (or browsing to one) creates the session immediately in that cwd. The
default landing (no project chosen yet) defaults to `$HOME` (the existing
`defaultNewSessionCwd`, `store.svelte.ts:171`).

**Why a view, not a dropdown:** the chooser is the entry surface for a brand-new
session — making it a real view (like the boot landing) gives it room for the
recent list + browse + worktree toggle without cramming them into a popover,
and it reads naturally as "where am I starting this?" rather than a config chip.

**Fast path:** the chooser opens with the top project pre-highlighted, so Enter
creates immediately — one keystroke to confirm. This preserves the speed of
today's ⌘N-then-type flow while still surfacing the chooser (a different project
is one arrow-down away). The project `+` header needs no chooser (its cwd is
known), so it skips straight to creation.

### Q4. Boot landing — create-on-interact, not on boot

**Finding:** today `startDraft(defaultNewSessionCwd)` fires on boot when no
session restores (`store.svelte.ts:1490,1524`) and on boot-restore failure.

**Decision:** on boot, if a session restores, open it (unchanged). If none
restores, show a **landing state** (the `NewSession.svelte` "What would you like
to work on?" prompt can be repurposed as a non-draft landing) that creates the
session on first interaction (first prompt or first config pick) — *not*
auto-spawning a daemon on boot. This avoids a daemon spawn at cold start for a
user who may just be glancing at the app. The landing composes the first prompt
+ any config picks, then issues one `newSession` (the server already supports
bundling the first prompt in `new_session`, `hub.rs:1654`).

**This is the one place a "deferred create" survives** — but it's a true landing
(no `store.draft` overlay over a stale `store.session`; the landing is a
distinct empty state), so it does not reintroduce the stale-state bug class.

**Leak-free mechanism:** the landing's pre-create config picks live in a
dedicated **landing-state object scoped to the landing component** — *not*
`store.draft`, and *not* readable by `App.svelte`'s gated surfaces
(approvals/plan view/right context panel all read `store.session`, which the
landing leaves null/empty). The only path the landing's config takes is into the
single bundled `newSession` call; once the session is created, the landing
object is discarded and config is re-fetched from the real session's state.
This is what distinguishes it from `store.draft`, which overlayed `store.session`
and leaked into every surface that read it.

### Q5. Warm-pool eviction — empty sessions evicted first

**Finding:** the warm cap evicts the least-recently-focused *idle* session when a
9th warms (`polytoken/driver.rs:1175`, `shared/warm_cap.rs::eviction_plan`). The
`evictable` predicate skips running sessions (mid-turn) and the protected id; it
does **not** prefer empty sessions. So spamming `+` can evict a real (idle, but
populated) session's daemon to make room for a throwaway empty one — the worst
case of the daemon-churn risk.

**Decision:** add an **empty-first** priority to eviction. Among evictable (idle)
sessions, evict **empty** (never-prompted) sessions before any session that has
a transcript. Only when no empty sessions remain does it fall back to plain LRU.
Concretely: add a `has_prompt` signal on `WarmSession` (a new field, e.g.
`has_prompt: AtomicBool`, set when the first prompt is accepted via the prompt
path). Note: `user_message_count` exists on `SessionListEntry`
(`session_driver.rs:502`) but is hardcoded to `0` for warm sessions
(`driver.rs:1888`, `sessions_registry.rs:276` — the daemon's `SessionStateSnapshot`
does not expose a per-session message count), so this is net-new tracking, not a
reuse of an existing signal.

**Mechanism:** `eviction_plan` is a pure function that iterates `order`
(oldest→newest LRU) and picks the first N evictable ids — it has no notion of
priority. Preserve its contract + existing tests unchanged by doing **two passes
at the call site** (`driver.rs:1175`): first call `eviction_plan` with an
`evictable` predicate that requires `has_prompt == false` (empty sessions only);
if that doesn't yield enough victims, call again with the original predicate
(plain LRU) for the remainder. This keeps `shared/warm_cap.rs` untouched.

**Effect:** spamming `+` only ever reaps throwaway empty sessions until none are
left — real work is protected. This directly defuses the daemon-churn risk: the
cost of stray clicks now lands entirely on sessions the user never used.

**Why not also evict empty sessions under the idle reaper sooner?** The idle
reaper (10 min) already bounds the lifetime of any untouched warm attachment. The
empty-first rule changes *which* session loses its daemon at cap time, not
*when* an idle one is reaped — they compose cleanly.

## What gets removed

- `store.draft` and the entire `draft`/`draftMap`/`draftConfigMap`/
  `pendingDrafts`/`composerDraftKey` (`n:<cwd>`) machinery
  (`store.svelte.ts:330–765`, ~106 references in that file alone).
- `NewSession.svelte` as a draft view (repurposed as the boot landing, Q4).
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
  class; daemon-spawn-on-click accepted as the tradeoff, bounded by warm cap +
  idle reaper).

## Migration path (for the follow-up implementation issue)

Phased so each step leaves the app working:

1. **Pre-create chooser (Q1 + Q3):** build the `ProjectMenu`-based `+`/⌘N entry
   with the worktree toggle, calling `newSession` immediately on pick. Land
   *alongside* the existing draft path (feature-flagged) so both work during
   migration.
2. **Live config switches (Q2):** ensure the config chips issue live
   `SessionAction`s post-create. (Most already exist for live sessions; verify
   the post-create-immediate path.)
3. **Boot landing (Q4):** repurpose `NewSession.svelte` as a true landing that
   creates on first interaction.
4. **Empty-first eviction (Q5):** add a `has_prompt` field on `WarmSession`
   (set when the first prompt is accepted), and do the two-pass `eviction_plan`
   call at `driver.rs:1175` so empty (never-prompted) sessions are evicted before
   any with a transcript. Unit-test the new two-pass policy in `driver.rs`'s test
   module (the call-site behavior; `shared/warm_cap.rs` stays untouched per Q5).
5. **Remove the draft overlay:** delete `store.draft` + persistence layer +
   sidebar draft rows + `creatingSession` placeholder + `submitDraft`.
6. **Remove the `!store.draft` gates** in `App.svelte` — surfaces read the real
   session. Verify each formerly-gated surface (approvals, plan view, right
   context panel, context-pressure cue) behaves correctly against an empty
   freshly-created session.
7. **Remove the server-side deferred-apply logic** in `polytoken/driver.rs`.
8. **Rewrite e2e:** replace `e2e/drafts.e2e.ts` with new-session-creates-
   immediately tests; update `e2e/file-mention.e2e.ts` (the draft-cwd
   fallback test at line 19 changes shape — a fresh empty session *has* a cwd
   and its skills load via the normal `atRefs` push).
9. **Revise `docs/DECISIONS.md`** "Draft persistence" entry.

## Acceptance Criteria

These validate the *design* is complete and actionable for a follow-up
implementation issue — they are not code-testable in this issue (no code is
written). They are verified by **operator review against the codebase**, not by
the document asserting its own sections exist.

- **AC.1** The design resolves all five open questions (worktree, config chips,
  ⌘N chooser, boot landing, warm-pool eviction) with a concrete decision
  grounded in the codebase.
  Verified by: operator review confirms each question has a concrete decision,
  and each decision's file:line citation is accurate against the repo
  (spot-checked by plan-reviewer).
- **AC.2** The design identifies the full removal surface (what gets deleted)
  and the migration phasing. Verified by: operator review confirms the
  removal-surface list and migration phases are complete against a grep of
  `store.draft`/draft-persistence references in the client tree (the ~166
  references / 10 files named in "Scale of the draft concept").
- **AC.3** The design names the decision it revises (DECISIONS.md "Draft
  persistence") and the new tradeoff (daemon-on-click, bounded by warm cap +
  idle reaper). Verified by: operator review confirms the DECISIONS.md entry is
  cited (line 47) and the warm-cap/idle-reaper bounds are real
  (`config.rs:142,143`, checked against the repo).
- **AC.4** The design confirms all draft config fields have a live post-create
  path (so nothing is lost), singling out worktree as the one pre-create-only
  field. Verified by: operator review confirms each config field maps to a live
  `SessionAction` endpoint (`wire.rs:518,528,531,534,507`) and worktree is
  created only at `new_session` (`driver.rs:2425`), with no live "convert"
  action — checked against the repo.

## Test Strategy

No code is written in this issue, so no tests are written here. The design
*specifies* the test shape the follow-up implementation issue must satisfy:

- The follow-up must add an e2e test reproducing issue #91's scenario: create a
  session in project A, `+` a session in project B (with B-specific skills),
  type `@skill:` in B, and assert B's skills (not A's) appear. Against the mock
  this requires making `mock_driver.rs::list_at_refs` session/cwd-aware (today
  it returns a fixed list regardless of session, `mock_driver.rs:2781`).
- The follow-up must replace `e2e/drafts.e2e.ts` with new-session-creates-
  immediately tests covering: project `+` header (immediate create), ⌘N chooser,
  worktree toggle pre-create, boot landing, config chips as live switches.
- **Test-infrastructure gap flagged:** the current mock driver cannot reproduce
  per-project skill differences, so a regression test for #91's exact scenario
  is not possible until `list_at_refs` is made session/cwd-aware in the mock.
  This is implementation work for the follow-up issue, explicitly called out
  here so it isn't missed.

## Review Strategy

This is a design doc. It should be reviewed by the operator (the author of the
"Draft persistence" decision) for agreement before a follow-up implementation
issue is filed. The `plan-reviewer` subagent checks the plan shape against the
spec; since no code ships, implementation review does not apply.

## Documentation Strategy

- Revise `docs/DECISIONS.md` "Draft persistence" (line 47) — **in the follow-up
  implementation issue**, not this design doc (this issue records the decision
  to pivot; the DECISIONS.md edit lands with the code).
- Add a note to `docs/TODO.md` near line 59 (the prior "new session view leaked
  previous session's state" entry) cross-referencing this design as the
  structural fix for the whole bug class. **In the follow-up implementation
  issue**, not this design doc.

## Risks, Blockers, and Required Decisions

- **Risk: cannot regression-test #91's exact scenario.** The mock driver's
  `list_at_refs` returns a fixed skill list regardless of session
  (`mock_driver.rs:2781`), so the follow-up must first make it session/cwd-aware
  before the A→B skills-isolation e2e test can be written. Until that
  infrastructure work lands, the #91 regression is unguarded. (Surfaced in Test
  Strategy too; this entry mirrors it here per the plan-spec's requirement that
  test-infrastructure gaps appear in Risks.)
- **Risk: daemon-spawn churn.** Stray `+` clicks spawn daemons. Mitigated by
  warm cap (8) + idle reaper (10 min), and **further defused by empty-first
  eviction (Q5)** — stray clicks only ever evict throwaway empty sessions, never
  real work. If this still proves too costly in practice, the boot-landing
  "create-on-interact" pattern (Q4) could be extended to the `+`/⌘N path as a
  fallback — but that reintroduces a deferred-create overlay, so it should only
  be done if churn is observed as a real problem despite Q5.
- **Risk: worktree UX.** The pre-create worktree toggle is the one piece with no
  existing live-switch fallback. The right-click "New worktree session" on the
  project `+` header is new UI; the default left-click stays one-tap.
- **Risk: large refactor surface.** ~166 references. Phased migration (feature-
  flagged alongside the old path) mitigates this; each phase ships independently.
- **Decision required from operator (already answered):** scope = design-first,
  no code. The five open questions are resolved in this doc; if the operator
  disagrees with any resolution, that blocks the follow-up implementation issue.
