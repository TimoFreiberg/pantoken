# PLAN — Live-driver robustness: review of landed fixes + remaining design

Status: **design + review, awaiting owner sign-off** (2026-07-02, from the design-dossier
track; grounded against source at commit `rlntluvk`). Companion: `PLAN-protocol-v2.md`
(the switchTo attach-window fix lives there).

Three of the four robustness clusters landed on 2026-07-02 while this design was in
flight: the `sessionReset` reset channel (`tnxuknwv`), pending-interrogative recovery
(`spuomuzx`), and SSE reconnect/backoff/liveness (`luluvsmy`). This doc therefore has
three parts: a review of what landed, the design for what remains (daemon-exit watcher,
lease re-claim, degraded-state surfacing), and the supervisor-vs-patch verdict.

## Part A — Review of the landed fixes

### A1. SSE reconnect (`daemon-client.ts:1087-1233`) — core is right, one real defect

The architecture is sound: per-attempt `AbortController` + `stopped` flag cleanly
separates retry-abort from shutdown-abort, backoff is abortable (unsubscribe exits in a
microtask), SSE parsing handles `id:` lines, multi-line `data:`, and CRLF per spec.

**Defect — idle sessions reconnect-cycle forever.** The daemon's SSE is push-only with
no heartbeats when idle (`daemon-client.ts:11-12`, spike-confirmed). The liveness watcher
(`:1107-1113`) aborts whenever no frame arrived for 60s — which on an *idle* session is
always. Every ~60-120s: abort → refetch → synthetic `stream_discontinuity` (`:1142-1147`)
→ event-map reseed → `sessionReset` + full transcript re-emit to every viewer. An idle
viewed session pays a 2-round-trip reseed and a full client re-render every minute,
forever (and under protocol v2 each one is an epoch bump, killing resume). Fix: probe
before killing — on liveness expiry, `GET /health` with a short timeout (~5s); if it
answers, the daemon is alive-and-idle: reset `lastFrameAt`, do nothing; only when the
probe fails/hangs, abort the fetch and reconnect. Test: fetch-mock an idle stream +
healthy `/health`, assert zero reconnects over 3 liveness periods; then a hanging
`/health`, assert reconnect.

Two nits: (1) `TextDecoder` state persists across attempts (`decoder` is per-subscribe,
`:1091`) — a multi-byte char split by the abort can corrupt the first frame of the next
attempt; allocate the decoder per attempt. (2) The discontinuity is emitted on *every*
reconnect even if the daemon someday honors `Last-Event-ID` — fine today (support
unconfirmed, upstream ask open); when it's confirmed, gate the discontinuity on the first
resumed `seq` not being contiguous with `lastEventId`.

> **Landed 2026-07-02:** the A1 defect fix + nit (1) shipped exactly as specced —
> probe-before-kill (bounded `GET /health`, `probing` single-flight flag,
> test-shrinkable `livenessIntervalMs`/`livenessProbeTimeoutMs` knobs) with both
> prescribed unit tests, and the per-attempt `TextDecoder`. Nit (2) stays open
> pending the upstream `Last-Event-ID` ask.

### A2. `sessionReset` channel — correct, but invisible to e2e

Hub folds it (clears `items`, preserves meta — `state.ts:538-545`), driver emits reset +
fresh events, no duplication. **Gap: no mock parity.** `mock-driver.ts` never emits
`sessionReset`, so no e2e exercises the reset path and the dev bar can't drive it. Add: a
mock script (`fixtures.ts`) that emits `sessionReset` + a reseeded transcript, a dev-bar
button, and an e2e asserting the transcript is replaced, not duplicated. Cheap, and it's
the regression net for the fold's one destructive case.

> **Landed 2026-07-02:** `resetReplay` fixture (`sessionReset` → replayed
> user/assistant turn), `reset` dev-bar script, and `e2e/session-reset.e2e.ts`
> asserting old transcript gone + exactly one copy of the replayed prompt.

### A3. Pending-interrogative recovery — sound; one determinism check

`recoverPendingInterrogatives` (`polytoken-driver.ts:591-607`) maps `pending_interrogatives`
through `mapDaemonEvent` and re-executes `registerInterrogative` effects, riding the seed.
Re-registration *overwrites* the pending map entry — safe iff the mapping is
deterministic per interrogative (same `interrogativeId` → same reverse-response shape;
verify no `Date.now()`-derived request ids in that path). The brief's "dedupe against
live-registered ids" concern is real only during the switchTo attach window, which is
being fixed protocol-side (see PLAN-protocol-v2 §switch window) — don't double-fix here.

## Part B — Remaining design

One shared primitive, then two features on top of it.

### R1. Session health tri-state + operator surfacing

Both remaining holes end in "the operator must see it". Add to `WarmSession`:
`health: "live" | "degraded" | "dead"` with a single chokepoint
`setHealth(ws, health, reason)` that (a) emits a `hostUiRequest{kind:"notify"}` at
`warning` (degraded) / `error` (dead) so the transition is visible in the transcript
(crash-loud rule), and (b) reflects it cross-session: extend `SessionAttention.phase`
(`wire.ts:128`) with `"degraded"` so the sidebar row shows it without folding background
transcripts. Additive union member; client and server deploy together (the server serves
the bundle + the new PROTOCOL_VERSION check catches stragglers). `subscribe()` gains an
optional `onHealth?: (s: "connected" | "reconnecting") => void` callback — the loop
already knows both moments (`:1138`, `:1200`); the driver maps reconnecting-for->2
attempts to degraded, connected to live. Tests: hub unit test asserting attention
carries `degraded`; driver unit test with a fetch-mock that fails twice then connects.

### R2. Daemon-exit watcher

States: `LIVE → DEAD` (no recovery state — a dead daemon never comes back on its own;
Reopen re-warms). Two detection paths, both cheap:

- **Spawned daemons:** the driver spawned it, so own the child — `Bun.spawn`'s `exited`
  promise (the seam `_setSpawnForTesting` already stubs spawn). On exit while the session
  is warm: `setHealth(dead, "daemon exited (code N)")` + emit
  `sessionClosed{reason:"failed"}`.
- **Attached daemons (not our child):** classify errors in the SSE retry loop —
  `ECONNREFUSED` (or unix-socket `ENOENT`) means the process/port is gone, unlike
  timeouts (sleep/network blips). 3 consecutive refusals → same dead path. Timeout-class
  errors keep backing off (R1 shows degraded meanwhile).

**Reopen affordance:** `reloadSession` (wire.ts:349) already is the re-warm path. Client:
when a session shows `dead`/failed-closed, the transcript banner offers "Reopen" →
`reloadSession(path)` (needs a `title` tooltip per repo rule). Tests: stubbed spawn whose
`exited` resolves → assert sessionClosed + notify; fetch-mock refusing thrice → same;
e2e via a new mock script `daemon-exit`.

### R3. Lease re-claim

Today heartbeat 404/409 → `clearLease()` and nothing else (`daemon-client.ts:719-724`) —
and the comment's claim that "the SSE will gap and the driver will re-seed" is **wrong**:
the SSE subscription is lease-independent; pilot keeps driving without exclusivity while
a TUI may attach → two writers on one session. Design (states on the client object):
`HELD → LOST → (RECLAIMING ⇄ CONFLICTED) → HELD`. On heartbeat 404/409: keep the loud
log, `setHealth(degraded, "attachment lease lost")`, then `claimLeaseWithRetry` (exists,
`:702-707`) on a timer with jitter. Outcomes: success → re-heartbeat, **reseed** (state
may have moved while unleased — the existing reseed path), `setHealth(live)`; 409 with a
live holder → stay degraded with the holder summary in the notice ("TUI attached —
detach there to resume") and retry only after the parsed `expires_at`. Fix the wrong
comment in the same commit. Tests: fetch-mock heartbeat→404, claim→200 (reclaim+reseed);
heartbeat→409 with holder body (degraded, no tight retry loop).

## Part C — Supervisor vs patch-in-place: verdict

**Patch-in-place wins.** The supervisor variant's premise was four unowned failure paths
scattered across module functions; three of them landed *today* as in-place patches with
their own tests. A `DISCOVERING→…→DEAD` supervisor would now mean churning ~600 lines of
freshly-tested code to re-house working logic — structural aesthetics, no operator-visible
gain, real regression risk. What we keep from the supervisor idea is its one genuinely
good part: a **single health field with a single chokepoint** (R1), which is 90% of the
observability for 5% of the refactor. Revisit only if the lifecycle grows two more
concerns (e.g. daemon version-gating + auto-restart policies) — that's the point where
scattered patches stop composing.

## Non-goals

- No auto-restart of a dead daemon (Reopen is explicit; auto-restart loops on a
  crash-looping daemon are worse than a loud DEAD state).
- No daemon-side changes; the `Last-Event-ID` resume ask stays tracked upstream.
- No switchTo-window fix here (protocol v2 owns it).

## Owner decisions needed

1. R2 dead-notice UX: banner-with-Reopen inside the transcript vs auto-reopen-once? Spec
   says banner (crash-loud, no hidden retries).
2. R3 while CONFLICTED (a TUI legitimately holds the lease): should pilot keep the session
   read-only-visible (current transcript, composer disabled with a reason tooltip) or
   show only the notice? Spec assumes read-only-visible.
3. Ordering: R1+A1-fix first (small, immediately felt), then R3, then R2 — OK?
