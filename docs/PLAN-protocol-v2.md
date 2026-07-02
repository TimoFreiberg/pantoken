# PLAN — Protocol v2: seed-events-on-connect + seq/epoch resume

Status: **implemented** (2026-07-02, five commits: journal dark → seed flip /
PROTOCOL_VERSION 2 → tail resume + requestSeed → backpressureLimit → attach-window
buffering; owner signed off with the defaults: ring cap 1024 frames/256KB,
`requestSeed` message, /debug/state fold-on-read — verified no high-frequency
scraper exists). Companion: `PLAN-driver-robustness.md`, the Rust-hub go/no-go
criteria in `ADR-desktop-shell.md`. **As-built deltas from this design are
recorded at the bottom** — read them before citing section details.

## Decision

Adopt the **journal-first architecture with minimal-diff sequencing**. The two dossier
variants converge: a ring buffer of seq-stamped wire frames *is* a bounded journal. So we
make a per-session **append-only journal of stamped events** the hub's primary structure
(it is simultaneously the seed source, the resume ring, and the future Rust-hub core), but
we land it in small commits that keep the existing fold/tests green until the last step
deletes the server-side fold dependency.

Why not pure minimal-diff (ring bolted next to `sessionStates`)? Two structures holding
the same events drift, and the Rust-hub payoff (hub becomes a journaling router, no
foldEvent port) only materializes when the journal is authoritative.

## Wire changes (protocol/src/wire.ts)

```ts
export const PROTOCOL_VERSION = 2;

// ServerMessage additions/changes
| {
    type: "seed";
    sessionId: SessionId;
    epoch: number;          // identity of this transcript build
    seq: number;            // seq of the last event folded into this seed
    events: readonly SessionDriverEvent[];  // fold from initialSessionState()
  }
| { type: "event"; event: SessionDriverEvent; epoch: number; seq: number }
// `snapshot` (wire.ts:143) is DELETED in the final commit.

// ClientMessage change
| {
    type: "hello";
    auth?: string;
    /** Tail-resume request: "I hold sessionId folded through {epoch, seq}". */
    resume?: { sessionId: SessionId; epoch: number; seq: number };
  }
```

Per-connection replies (`editorPrefill`, `promptResult`, `queueRestored`, wire.ts:250-266)
are not part of the fold and stay unstamped. Cross-session meta (`sessionList`,
`sessionStatus`, lists) is cheap, idempotent, and re-sent on connect — unchanged.

**Version gating instead of dual-path.** The server serves the client bundle, and the
client now hard-fails on `protocolVersion` mismatch with an "Update required" screen
(landed 2026-07-02). So v2 needs **no snapshot+seed transition period**: bump to 2 in the
flip commit; a stale service-workered PWA gets the mismatch screen, not silent misfolds.
This is the payoff of that check — use it.

## Hub: the journal (server/src/hub.ts)

```ts
interface SessionJournal {
  epoch: number;
  seq: number;                 // last assigned
  compacted: SessionDriverEvent[]; // history prefix, delta-coalesced, no seq gaps needed
  tail: { seq: number; ev: SessionDriverEvent }[]; // live ring, resume source
}
```

- **Single append path.** Today events enter state two ways: `onEvent` (hub.ts:343-384)
  and `refreshUsage`'s inline fold+send (hub.ts:605-620). Unify: both call
  `ingest(ev)` which appends to the journal (assigning `seq`), folds into the legacy
  state (until the deletion commit), and routes `{type:"event", event, epoch, seq}` to
  viewers. The usage side-door joining the journal is mandatory — otherwise resume
  replays diverge from what the client folded.
- **Seed build.** `seedOf(sid)` = `compacted` + `tail` events, with adjacent
  `assistantDelta`s of the same open message concatenated at build time (fold-equivalent:
  the fold appends text — byte-identical result, property-tested). `structuredClone`
  dies with `snapshotOf` (hub.ts:331-334); a seed is plain JSON-serializable data already.
- **Epoch bumps** (transcript identity changes; resume across a bump is impossible):
  session first warmed/attached; `sessionReset` folded (clear / rewind / branch /
  stream-discontinuity reseed — the driver's reset channel that landed 2026-07-02,
  state.ts:538-545); `reloadSession`. On bump: `epoch++`, `seq = 0`, `compacted` rebuilt
  from the fresh seed events, `tail` cleared.
- **Ring sizing.** `tail` capped at 1024 frames or 256KB serialized, whichever first
  (drop-oldest; a resume older than the tail → full seed). Compacted prefix is bounded by
  the transcript itself. Worst case at the warm-cap (8 sessions × ~0.5MB) ≪ 10MB on the
  Mac Mini. Sessions nobody views keep NO journal (unchanged policy, hub.ts:365-373):
  journals exist only for seeded sessions.
- **Ordering guarantee.** The hub stays the single writer; `seq` is assigned in `ingest`
  in arrival order — the same total order every client folds. No cross-session ordering
  is promised (none is today).
- **/debug/state** re-derives on demand via `foldAll(seedOf(sid))` (state.ts:551-557
  already exists). Dev-only cost, zero steady-state fold work.

## Connect, resume, desync, switch window

- **addClient** (hub.ts:1100-1106): `hello` then `seed` for the focused session (or an
  empty seed for the landing). With `hello.resume`: if `sid` known, `epoch` matches, and
  `seq >= tail[0].seq - 1` → send `{type:"event"}` frames from the tail (`> seq`) instead
  of a seed; else full seed. Resume saves the full-transcript re-send on every phone
  wake — the case that hurts over LTE.
- **rawSend drop → re-seed** (index.ts:154-155): Bun signals backpressure drop by return
  code (-1 queued, 0 dropped) — the try/catch around `broadcast` (hub.ts:667-675) is dead
  code for this. Change `Send` to return the code; in `ingest`'s route loop, a `0` return
  marks that conn desynced and schedules (microtask, coalesced) a fresh `seed` for its
  focused session + re-push of meta lists. Set an explicit `maxBackpressure` in the WS
  config while there.
- **switchTo attach window** (hub.ts:1027-1068): during `swap()` (driver GET /state +
  GET /history), SSE events for the target sid hit `onEvent` but fold nowhere. Fix in the
  hub: while any swap is in flight, buffer events for sids without a journal (bounded:
  256 events / 5s TTL). When the seed lands, replay buffered events newer than the seed's
  **SSE watermark**: the daemon-client now parses SSE `id:` lines (landed 2026-07-02) —
  the driver stamps the seed with the last SSE id seen before its /state fetch, and
  buffered events carry theirs. No ids available (daemon support unconfirmed) → fallback:
  if anything was buffered for that sid, immediately rebuild the seed once (epoch bump,
  re-seed) — heavier but correct, and it's the rare-race path only.

## Client (client/src/lib/store.svelte.ts)

Handle `seed`: fold `events` into a fresh `initialSessionState()` off to the side, then
swap it in — the exact place `snapshot` is replaced today; the fold code is already
shared. Track `{sessionId, epoch, seq}` of the focused session; send it as
`hello.resume` on reconnect. Drop any `event` whose `epoch` ≠ current (stale frames
racing a reseed) and treat a `seq` gap as desync → request a fresh seed (re-send `hello`
or a tiny `requestSeed` message — implementor's choice, spec'd as `requestSeed`).

## Landable commits (each independently green)

1. **Journal + stamping, dark.** Add `SessionJournal`, `ingest()` unification (including
   the usageUpdated side-door), seq/epoch assignment, seed-build with delta coalescing.
   Nothing on the wire changes. Tests: property test `foldAll(seedOf(sid))` ≡ legacy
   folded state across the mock fixture scripts (hub.test.ts); coalescing equivalence;
   epoch-bump on sessionReset.
2. **Flip connect/switch to seed; PROTOCOL_VERSION = 2.** addClient + switchTo send
   `seed`; client folds it; `snapshot` type deleted; `snapshotOf`/`structuredClone`
   deleted; /debug/state → `foldAll`. Tests: adapt the hub connect/switch tests to assert
   seeds; e2e suite (it asserts DOM, not wire shapes — should pass unmodified); one e2e
   asserting the update-required screen on version skew (mock an old client hello).
3. **Resume.** `hello.resume` + tail replay + client epoch/seq tracking + `requestSeed`.
   Tests: unit — resume inside tail, resume past tail (full seed), resume across epoch
   bump (full seed); e2e — reconnect mid-stream (dev-bar hook to force `ws.close()`)
   shows no duplicated bubbles.
4. **Desync detection.** `Send` returns Bun's code; drop → mark + coalesced re-seed;
   `maxBackpressure` explicit. Tests: unit with a stubbed send returning 0 asserts
   exactly one re-seed; no re-seed storm under repeated drops.
5. **Switch-window buffering.** Buffer + watermark replay + rebuild fallback. Tests:
   unit with a scripted driver emitting during swap; e2e using the mock's scripted
   streaming during a session switch.

Steps 3-5 are independent of each other; 2 depends on 1.

## Non-goals

- No persistence of the journal (in-memory; durability comes free from the daemon's
  files via history-seed — a hub restart is an epoch bump everywhere).
- No per-event acks, no client→server flow control, no multi-writer story.
- No change to `HostUiResponse`'s untagged-union shape (tracked separately; don't couple).
- No Rust port in this plan — this plan is what *makes* the port mechanical later.

## Owner decisions needed

1. **Ring cap** 1024 frames / 256KB per session OK? (Bigger = longer resumable gap,
   more RAM.) — **Decided: defaults taken.**
2. **`requestSeed` message vs re-`hello`** for client-detected desync — spec'd as a new
   tiny message; re-hello also re-triggers the meta pushes (wasteful but simpler).
   — **Decided: `requestSeed`.**
3. Commit 2 deletes `/debug/state`'s always-materialized shape (it becomes fold-on-read).
   Any tooling of yours scraping it at high frequency? — **Verified no: the only
   consumers are one Playwright `expect.poll` (e2e/stop-turn) and ad-hoc agent
   curls; the parity harness explicitly refuses it as an oracle.**

## As-built deltas (2026-07-02, implementation)

1. **sessionReset restarts the journal behind a synthetic meta prefix.** The design
   said "compacted rebuilt from the fresh seed events", but at the moment a reset
   folds there ARE no fresh events yet (the driver re-emits them afterwards), and
   the fold *preserves* ref/title/config/queued/approvals/ambient across a reset.
   `metaSeedEvents(state)` (server/src/journal.ts) synthesizes a minimal prefix —
   one `sessionOpened` projection + ambient/approval `hostUiRequest`s — that
   reproduces exactly the carried-over state, property-tested as
   `foldAll(metaSeedEvents(s)) ≡ {...s, items: []}`. Viewers of a reset get a fresh
   (tiny) **seed message instead of the routed reset event**: correct even for a
   viewer that had silently missed a frame, and it hands them the new epoch base
   in one message.
2. **Commit 4 kept close-on-drop instead of the in-band re-seed.** `sendOrClose`
   (landed independently, tested) closes on Bun's drop signal; with resume landed,
   the reconnect costs a hello + tail replay of exactly the gap — the expensive
   full re-snapshot that motivated in-band recovery no longer exists. In-band
   re-seed also has a self-defeating failure mode: the recovery seed is the largest
   message we send, pushed into a socket that just proved backpressured. As-built:
   explicit `backpressureLimit: 4MB` (Bun's real option name; default 16MB),
   `closeOnBackpressureLimit` left false so `sendOrClose` owns the close.
3. **Commit 5 ships the rebuild-once fallback only; the SSE-id watermark is
   deferred.** Buffered attach-window events are the *signal* to re-run the swap
   once (the second fetch is strictly after the daemon accepted them), never folded
   directly (no watermark exists to dedupe them against the seed). Retry is
   restricted to idempotent swaps (openSession/reloadSession) — a raced
   newSession would create a second session, so it logs loud instead. Residual: an
   event racing the *second* fetch (one-fetch-wide, needs the daemon `Last-Event-ID`
   /state watermark — upstream ask; revisit when confirmed).
4. **Epochs are process-unique** (ms-seeded counter), so a resume token minted
   against a previous hub process can never falsely tail-match a fresh journal —
   a hub restart reads as an epoch bump everywhere, as intended.
5. **Attach is hello-gated in both auth modes** (index.ts): the resume token rides
   the client's hello, so `addClient` must not fire at socket-open even in
   tokenless dev — the client always sends a hello immediately on open.
