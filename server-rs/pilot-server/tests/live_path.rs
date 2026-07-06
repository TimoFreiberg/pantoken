//! Live-path integration tests for `PolytokenDriver`.
//!
//! These exercise the real driver stack (`warm_session` → `DaemonClient` →
//! `event_map`) against the in-process fake daemon (`support::fake_daemon`),
//! which replays the frozen corpus over a real ephemeral axum port. The
//! spawn-override seam (`daemon_client::set_spawn_override`) swaps the process
//! launch for the fake, so the *only* thing not real is the daemon binary.
//!
//! **Test isolation:** the spawn-override is process-global, so every test in
//! this file takes the same `OVERRIDE_MUTEX` before setting/clearing it. This
//! serializes the injecting tests within this binary (cargo runs test binaries
//! in separate processes, so there's no cross-binary bleed). Do not remove the
//! guard without replacing it with equivalent serialization.

mod support;

use std::sync::Arc;

use pilot_daemon_types::SseEnvelope;
use pilot_protocol::session_driver::{SessionDriverEvent, SessionRef, WorkspaceRef};
use tokio::sync::Mutex;

use pilot_server::driver::{NewSessionOptsData, PilotDriver};
use pilot_server::polytoken::daemon_client::{
    SpawnDaemonOpts, SpawnedDaemon, clear_spawn_override, set_spawn_override,
};
use pilot_server::polytoken::driver::PolytokenDriver;
use pilot_server::polytoken::event_map::{self, DaemonEffect, MapCtx};

use support::corpus as corpus_loader;
use support::corpus::ScenarioFile;
use support::fake_daemon;

/// Serializes spawn-override use within this test binary (the override is
/// process-global). Every test below locks this before touching the override.
/// A `tokio::sync::Mutex` (not `parking_lot`) so the guard can be held across
/// the `.await` points inside each test — the override must remain installed
/// for the whole test body (set → drive → clear).
static OVERRIDE_MUTEX: Mutex<()> = Mutex::const_new(());

/// The corpus version the harness pins (single frozen version per "pin the
/// corpus" — see PROGRESS.md D20).
const VERSION: &str = "0.4.0-unstable.7";

/// Install a spawn-override pointing at `fake`, returning a guard that clears
/// it on drop. Panics if the override is already set (caller bug).
struct OverrideGuard;
impl OverrideGuard {
    fn install(fake: Arc<fake_daemon::FakeDaemon>) -> Self {
        let port = fake.port;
        let session_id = fake.session_id.clone();
        set_spawn_override(Arc::new(move |_bin: &str, _opts: SpawnDaemonOpts| {
            let session_id = session_id.clone();
            Box::pin(async move {
                Ok(SpawnedDaemon {
                    session_id: session_id.clone(),
                    port,
                })
            })
        }));
        Self
    }
}
impl Drop for OverrideGuard {
    fn drop(&mut self) {
        clear_spawn_override();
    }
}

/// Build a driver pointed at a temp sessions dir (no real daemon needed).
fn make_driver() -> (PolytokenDriver, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let driver = PolytokenDriver::new(
        dir.path().to_path_buf(),
        "polytoken".into(), // never invoked — the override answers spawns
        false,
    );
    (driver, dir)
}

/// A minimal `MapCtx` for the pure-effect verification test (Phase A.5):
/// deserializes corpus SSE frames through `map_daemon_event` and asserts which
/// `DaemonEffect` they produce. Mirrors `event_map`'s own `TestCtx`.
struct PureCtx {
    r#ref: SessionRef,
    workspace: WorkspaceRef,
}
impl Default for PureCtx {
    fn default() -> Self {
        Self {
            r#ref: SessionRef {
                workspace_id: "w".to_string(),
                session_id: "s".to_string(),
            },
            workspace: WorkspaceRef {
                workspace_id: "w".to_string(),
                path: "/w".to_string(),
                display_name: None,
            },
        }
    }
}
impl MapCtx for PureCtx {
    fn r#ref(&self) -> &SessionRef {
        &self.r#ref
    }
    fn workspace(&self) -> &WorkspaceRef {
        &self.workspace
    }
    fn now(&self) -> String {
        "t".to_string()
    }
    fn snapshot(
        &self,
        status: pilot_protocol::session_driver::SessionStatus,
    ) -> pilot_protocol::session_driver::SessionSnapshot {
        // The effect-verification test only inspects `DaemonEffect`s, never the
        // emitted snapshot, so a default-shaped snapshot (built from no cached
        // state) suffices. Reuse the shared builder so we don't hand-roll the
        // many SessionSnapshot fields.
        event_map::snapshot_from_state(
            None,
            &self.r#ref,
            &self.workspace,
            status,
            &self.now(),
            None,
            None,
        )
    }
    fn live_status(&self) -> pilot_protocol::session_driver::SessionStatus {
        pilot_protocol::session_driver::SessionStatus::Idle
    }
}

// ===========================================================================
// Phase A — harness + spawn-seam smoke test (AC.1)
// ===========================================================================

/// AC.1: the fake-daemon harness serves a corpus scenario over a real ephemeral
/// axum port, and `PolytokenDriver` reaches it via the spawn seam. `new_session`
/// calls `spawn_daemon` (→ override → fake port) then health-poll → claim-lease
/// → `/history`. We assert all the lifecycle endpoints hit the fake (via its
/// recorded-call log), proving the spawn seam is exercised end-to-end.
#[tokio::test]
async fn harness_smoke_opens_session_and_seeds() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "smoke-1".into(), 0).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver();
    let seed = driver.new_session(NewSessionOptsData::default()).await;

    // The spawn seam ran: the driver made it through health → claim → history.
    assert!(
        fake.called("GET", "/health"),
        "spawn seam: GET /health not hit; calls: {:?}",
        fake.recorded_calls()
    );
    assert!(
        fake.called("POST", "/tui-attachment/claim"),
        "lease not claimed; calls: {:?}",
        fake.recorded_calls()
    );
    // The driver fetches /history to build the seed. The corpus doesn't record
    // /history for streaming-turn, so the harness returns a canned empty body —
    // the seed is therefore empty here, which is correct (no recorded history
    // items). The point of THIS test is the spawn seam, not the seed contents.
    assert!(
        fake.called("GET", "/history"),
        "GET /history not hit; calls: {:?}",
        fake.recorded_calls()
    );

    // The seed is whatever history_to_seed_events produces from the recorded
    // /history (empty for streaming-turn). Assert it's a valid Vec (not a panic).
    let _ = seed;
}

// ===========================================================================
// Phase A.5 — verify corpus scenario → effect mapping (pre-Phase-D insurance)
// ===========================================================================

/// Run a scenario's SSE frames through `map_daemon_event` and collect every
/// `DaemonEffect` produced. Used to confirm a scenario exercises the effect a
/// later Phase-D integration test will assert on.
fn effects_for_scenario(scenario: &ScenarioFile) -> Vec<DaemonEffect> {
    let ctx = PureCtx::default();
    let mut acc = event_map::create_accumulator();
    let mut effects = Vec::new();
    for frame in &scenario.sse {
        let envelope: SseEnvelope = frame
            .envelope()
            .unwrap_or_else(|e| panic!("frame deserialized: {e}"));
        let result = event_map::map_daemon_event(&envelope.event, &mut acc, &ctx);
        effects.extend(result.effects);
    }
    effects
}

/// streaming-turn ends in `message_complete` → a `FetchState` effect (per
/// event-map.test.ts:96). Confirms the scenario the Phase-D FetchState
/// integration test targets actually produces that effect.
#[tokio::test]
async fn streaming_turn_produces_fetch_state_effect() {
    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let effects = effects_for_scenario(&scenario);
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, DaemonEffect::FetchState { .. })),
        "streaming-turn should produce a FetchState effect; got: {:?}",
        effects.iter().map(|e| format!("{e:?}")).collect::<Vec<_>>()
    );
}

/// queue-while-in-flight carries `pending_turn_input_queued` → a `RefetchQueue`
/// effect (per event-map.test.ts:416). Confirms the scenario the Phase-D
/// RefetchQueue integration test targets actually produces that effect.
#[tokio::test]
async fn queue_while_in_flight_produces_refetch_queue_effect() {
    let scenario = corpus_loader::load_named(VERSION, "queue-while-in-flight");
    let effects = effects_for_scenario(&scenario);
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, DaemonEffect::RefetchQueue)),
        "queue-while-in-flight should produce a RefetchQueue effect; got: {:?}",
        effects.iter().map(|e| format!("{e:?}")).collect::<Vec<_>>()
    );
}

// ===========================================================================
// Phase B — warm-session lifecycle tests (AC.2)
// ===========================================================================

/// Subscribe to the driver and collect emitted events into a bounded channel.
/// Returns the subscription id (call `unsubscribe` to stop). The channel is
/// large enough to absorb a scenario's burst without blocking the emitter
/// (which uses `try_send` and would otherwise drop on a full channel).
fn collect_events(
    driver: &PolytokenDriver,
    cap: usize,
) -> (usize, tokio::sync::mpsc::Receiver<SessionDriverEvent>) {
    let (tx, rx) = tokio::sync::mpsc::channel(cap);
    let id = driver.subscribe(Box::new(move |ev| {
        // try_send: never block the emitter task (a dropped event fails the
        // test loudly via the receiver seeing too few events).
        let _ = tx.try_send(ev);
    }));
    (id, rx)
}

/// AC.2: after `new_session`, the warm session is SUBSCRIBED to daemon SSE and
/// FOLDING events — the thing that was entirely dead before Phase B. We stream
/// `streaming-turn` (whose 3rd SSE frame is `message_start`, which maps to a
/// `SessionUpdated { status: Running }`), subscribe to the driver, and assert a
/// `SessionUpdated` arrives from the SSE path (not from the seed).
///
/// This is the load-bearing proof that `warm_session` → `subscribe` →
/// `handle_sse_event` → `emit` is live end-to-end.
#[tokio::test]
async fn warm_session_subscribes_and_folds_sse() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    // Small inter-frame delay so the SSE consumer has time to fold before the
    // stream ends (the driver's per-event spawn is still in place until Phase C;
    // a zero delay can race the consumer task shutdown).
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "warm-1".into(), 5).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver();
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    // new_session warms + subscribes SSE before returning the seed.
    let _seed = driver.new_session(NewSessionOptsData::default()).await;

    // Wait for a SessionUpdated from the SSE path. `message_start` (frame 2)
    // emits one with status Running. Timeout so a dead SSE path fails the test
    // rather than hanging.
    let mut got_session_updated = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if matches!(ev, SessionDriverEvent::SessionUpdated { .. }) {
            got_session_updated = true;
            break;
        }
    }
    assert!(
        got_session_updated,
        "warm session did not emit a SessionUpdated from SSE; the SSE fold is not live. \
         calls: {:?}",
        fake.recorded_calls()
    );
}

/// AC.2: `reload_session` disposes the old warm session AND re-warms. We open a
/// session, observe one SSE-driven emission, call `reload_session`, then assert
/// the old warm was disposed (its SSE subscription stopped — no further
/// emissions from it) and the call returns without deadlock.
///
/// **Scope note:** the full re-warm (post-reload SSE flow) goes through
/// `open_session` → `warm_session_attach`, which resolves the daemon port from
/// `startup.json`. The harness doesn't write `startup.json` (that's the
/// session-registry/worktree port — Phase-2 item 5, explicitly out of scope),
/// so the attach path can't reach the fake after reload. This test therefore
/// asserts the in-scope half — disposal + no-deadlock — and leaves the
/// re-warm-via-attach emission assertion to when `startup.json` is wired. The
/// `warm_session_subscribes_and_folds_sse` test above already proves the warm +
/// fold path live; the reload disposal here proves the teardown half.
#[tokio::test]
async fn reload_session_disposes_old_warm_and_rewarms() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "reload-1".into(), 5).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver();
    let (sub_id, mut rx) = collect_events(&driver, 256);

    // Warm via new_session (spawn path) + subscribe SSE.
    let _seed = driver.new_session(NewSessionOptsData::default()).await;

    // Observe one SSE-driven emission (proves the first warm is live).
    let _first = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
        .await
        .expect("first warm produced no SSE emission")
        .expect("channel closed");

    // Reload — disposes the old warm (stops its SSE subscription, closes the
    // client), then re-opens. The re-open goes through open_session →
    // warm_session_attach, which needs startup.json (out of scope), so it
    // returns an empty seed — but the disposal MUST happen first and MUST NOT
    // deadlock. The call completing (Ok or the documented empty-seed path)
    // proves disposal ran without hanging on the old SSE stop.
    let path = "reload-1.jsonl".to_string();
    let reseed = driver
        .reload_session(path)
        .await
        .expect("reload_session ok");
    // No startup.json → empty seed (the attach path falls through). This is the
    // documented out-of-scope gap, not a failure.
    assert!(
        reseed.is_empty(),
        "expected empty re-seed (startup.json not wired); got {} events",
        reseed.len()
    );

    // After disposal + a short drain window, no more emissions arrive from the
    // OLD warm (its SSE subscription was stopped). A fresh emission here would
    // mean the old consumer is still live — a leak. Give it a moment to settle.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let leaked = rx.try_recv().ok();
    assert!(
        leaked.is_none(),
        "old warm session still emitting after reload disposal (consumer leak): {:?}",
        leaked
    );

    driver.unsubscribe(sub_id);
}

// ===========================================================================
// Phase 4 — multi-spawn fake-daemon harness
// ===========================================================================

#[tokio::test]
async fn multi_spawn_override_mints_fresh_fake_per_new_session() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = synthetic_idle_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "multi-smoke");
    let handle = override_guard.handle();

    let (driver, _dir) = make_driver();
    for _ in 0..3 {
        let _seed = driver.new_session(NewSessionOptsData::default()).await;
    }

    let spawned = handle.spawned();
    assert_eq!(spawned.len(), 3, "expected one fake daemon per new_session");

    let session_ids: std::collections::BTreeSet<_> = spawned
        .iter()
        .map(|spawned| spawned.session_id.as_str())
        .collect();
    assert_eq!(
        session_ids.len(),
        3,
        "each new_session should receive a distinct minted session id: {spawned:?}"
    );

    let ports: std::collections::BTreeSet<_> = spawned.iter().map(|spawned| spawned.port).collect();
    assert_eq!(
        ports.len(),
        3,
        "each fake daemon should bind a distinct ephemeral port: {spawned:?}"
    );

    for spawned in &spawned {
        assert!(
            spawned.called("GET", "/health"),
            "{} never warmed through /health; calls: {:?}",
            spawned.session_id,
            spawned.recorded_calls()
        );
        assert!(
            spawned.called("GET", "/state"),
            "{} never fetched /state; calls: {:?}",
            spawned.session_id,
            spawned.recorded_calls()
        );
        assert!(
            spawned.called("GET", "/history"),
            "{} never built a seed from /history; calls: {:?}",
            spawned.session_id,
            spawned.recorded_calls()
        );
    }

    let captured_opts = handle.captured_opts();
    assert_eq!(
        captured_opts.len(),
        3,
        "capture one SpawnDaemonOpts per spawn"
    );
    assert!(
        captured_opts.iter().all(|opts| opts.login_env.is_none()),
        "Phase 4 driver still passes login_env None; captured opts: {captured_opts:?}"
    );
}

// ===========================================================================
// Phase C — SSE ordering test (AC.3)
// ===========================================================================

/// Build a minimal `/state` + `/history` scenario (empty SSE) for the
/// multi-spawn harness: just liveness plus a `turn_in_flight` flag readable
/// from `/state`. The `/state` body is a full `SessionStateSnapshot` (pinned by
/// `synthetic_state_scenarios_deserialize_as_session_state`).
fn minimal_state_scenario(name: &str, turn_in_flight: bool) -> ScenarioFile {
    use serde_json::json;
    let json_str = json!({
        "scenario": name,
        "version": "test",
        "description": "minimal state/history scenario for multi-spawn harness tests",
        "canonicalization": {
            "session_id": "SESSION",
            "prompt_ids": {},
            "timestamps": "monotonic-from-T0"
        },
        "http": [
            { "method": "GET", "path": "/state", "status": 200,
              "response_body": { "session_title": "t", "todos": [], "flags": [],
                                 "env": {}, "project_cwd": "/PROJECT", "active_facet": "execute",
                                 "plugin_config": {}, "turn_in_flight": turn_in_flight } },
            { "method": "GET", "path": "/history", "status": 200,
              "response_body": { "items": [], "offset": 0, "total_projected_items": 0,
                                 "history_revision": 0, "session_id": "SESSION" } }
        ],
        "sse": [],
        "expected_driver_events": null
    })
    .to_string();
    serde_json::from_str::<ScenarioFile>(&json_str).expect("parse minimal synthetic scenario")
}

// Consumed now by `synthetic_state_scenarios_deserialize_as_session_state`, and
// in Phase 5 by the warm-cap in-flight-skip eviction test (AC.7 — a session
// whose /state reports turn_in_flight:true must never be evicted).
fn synthetic_turn_in_flight_scenario() -> ScenarioFile {
    minimal_state_scenario("synthetic-turn-in-flight", true)
}

/// Guard the synthetic `/state` fixtures against `SessionStateSnapshot` drift.
/// The driver's warm path deserializes `/state` into that type and *swallows* a
/// parse failure (`DaemonClient::get` uses `.ok()`), so a body missing a required
/// field (e.g. `plugin_config`) would leave `last_state = None` and silently
/// hollow out every scenario that depends on it — including the turn_in_flight
/// eviction case. This pins that both synthetic bodies fully deserialize and that
/// `turn_in_flight` survives the round-trip into the driver's state type.
#[test]
fn synthetic_state_scenarios_deserialize_as_session_state() {
    for (scenario, expect_in_flight) in [
        (synthetic_idle_scenario(), false),
        (synthetic_turn_in_flight_scenario(), true),
        (synthetic_ordering_scenario(1), false),
    ] {
        let state = scenario
            .http
            .iter()
            .find(|entry| entry.method == "GET" && entry.path == "/state")
            .and_then(|entry| entry.response_body.clone())
            .expect("scenario serves a GET /state body");
        let snapshot: pilot_daemon_types::SessionStateSnapshot = serde_json::from_value(state)
            .expect("synthetic /state must deserialize as a full SessionStateSnapshot");
        assert_eq!(
            snapshot.turn_in_flight.unwrap_or(false),
            expect_in_flight,
            "turn_in_flight must survive the round-trip into the driver's state type"
        );
    }
}

fn synthetic_idle_scenario() -> ScenarioFile {
    minimal_state_scenario("synthetic-idle", false)
}

/// Build a synthetic scenario whose SSE stream is: `message_start` →
/// `content_block_start` (text) → N `content_block_delta` (text, each carrying
/// its index as the delta text) → `content_block_stop` → `message_complete`.
/// Each delta maps to an `AssistantDelta { text: "<idx>" }`, so the receiver
/// can assert the emitted deltas arrive in the exact 0..N order — the
/// invariant the per-event `tokio::spawn` violated (probabilistically) and the
/// single per-session consumer now guarantees (deterministically).
fn synthetic_ordering_scenario(n: usize) -> ScenarioFile {
    use serde_json::json;
    let mut sse: Vec<serde_json::Value> = Vec::with_capacity(n + 4);
    sse.push(json!({
        "seq": 0, "emitted_at": "1970-01-01T00:00:00.000Z", "session_id": "SESSION",
        "event": { "type": "message_start", "prompt_id": "PROMPT_0" }
    }));
    sse.push(json!({
        "seq": 1, "emitted_at": "1970-01-01T00:00:01.000Z", "session_id": "SESSION",
        "event": { "type": "content_block_start", "prompt_id": "PROMPT_0", "block_index": 0,
                   "block_type": { "type": "text" } }
    }));
    for i in 0..n {
        sse.push(json!({
            "seq": (i as i64) + 2, "emitted_at": "1970-01-01T00:00:00.000Z", "session_id": "SESSION",
            "event": { "type": "content_block_delta", "prompt_id": "PROMPT_0", "block_index": 0,
                       "delta": { "type": "text", "text": i.to_string() } }
        }));
    }
    sse.push(json!({
        "seq": (n as i64) + 2, "emitted_at": "1970-01-01T00:00:00.000Z", "session_id": "SESSION",
        "event": { "type": "content_block_stop", "prompt_id": "PROMPT_0", "block_index": 0 }
    }));
    sse.push(json!({
        "seq": (n as i64) + 3, "emitted_at": "1970-01-01T00:00:00.000Z", "session_id": "SESSION",
        "event": { "type": "message_complete", "prompt_id": "PROMPT_0" }
    }));
    let json_str = json!({
        "scenario": "synthetic-ordering",
        "version": "test",
        "description": "N ordered text deltas",
        "canonicalization": {
            "session_id": "SESSION",
            "prompt_ids": {},
            "timestamps": "monotonic-from-T0"
        },
        "http": [
            // The driver's lifecycle calls: health, claim, state, history.
            // The fake supplies canned /health + /claim; /state + /history
            // return minimal bodies so warm-up completes.
            { "method": "GET", "path": "/state", "status": 200,
              "response_body": { "session_title": "t", "todos": [], "flags": [],
                                 "env": {}, "project_cwd": "/PROJECT", "active_facet": "execute",
                                 "plugin_config": {} } },
            { "method": "GET", "path": "/history", "status": 200,
              "response_body": { "items": [], "offset": 0, "total_projected_items": 0,
                                 "history_revision": 0, "session_id": "SESSION" } }
        ],
        "sse": sse,
        "expected_driver_events": null
    })
    .to_string();
    serde_json::from_str::<ScenarioFile>(&json_str).expect("parse synthetic scenario")
}

/// AC.3: SSE events fold sequentially through ONE per-session consumer (no
/// per-event `tokio::spawn`). A burst of 250 ordered text deltas yields
/// in-order emitted `AssistantDelta` events.
///
/// **Invariant guard, weakly discriminating pre-fix:** against the old per-event
/// `tokio::spawn` code, the failure was only probabilistic (unordered task
/// scheduling), so this test may pass even on the buggy code. It confirms the
/// fix WORKS post-fix; regression protection comes primarily from the
/// structural guard (`debug_assert` one-consumer-per-session in `install_warm`).
/// The burst is large (250) with a small inter-frame delay to give it what
/// discriminating power it can have.
#[tokio::test]
async fn sse_burst_folds_in_order() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    const N: usize = 250;
    let scenario = synthetic_ordering_scenario(N);
    // Tiny randomized-ish inter-frame delay (1ms) so the consumer tasks (in the
    // old design) would interleave; the single consumer processes sequentially.
    let fake = Arc::new(fake_daemon::spawn(scenario, "order-1".into(), 1).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver();
    let (_sub_id, mut rx) = collect_events(&driver, 512);

    let _seed = driver.new_session(NewSessionOptsData::default()).await;

    // Collect N AssistantDelta events (the text deltas). Other events
    // (SessionUpdated from message_start, etc.) are skipped. Timeout per recv
    // so a stall fails the test rather than hanging.
    let mut texts: Vec<String> = Vec::with_capacity(N);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while texts.len() < N {
        let ev = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("timed out waiting for AssistantDelta burst")
            .expect("channel closed before all deltas arrived");
        if let SessionDriverEvent::AssistantDelta { text, .. } = ev {
            texts.push(text);
        }
    }

    // Assert exact order: "0","1",…,"249".
    let expected: Vec<String> = (0..N).map(|i| i.to_string()).collect();
    assert_eq!(
        texts, expected,
        "SSE deltas folded out of order (expected 0..{N} in sequence)"
    );
}

// ===========================================================================
// Phase D — FetchState emit + RefetchQueue → queueUpdated (AC.4, AC.5)
// ===========================================================================

/// AC.4: a `FetchState` effect (from `message_complete`) emits the post-fetch
/// `RunCompleted` event with the threaded `prompt_id` as both entry ids, AND
/// the driver fetched fresh state (a `GET /state` hit the fake). The
/// streaming-turn scenario ends in `message_complete` → FetchState.
#[tokio::test]
async fn fetch_state_emits_run_completed_with_prompt_id() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "fetch-1".into(), 5).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver();
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    let _seed = driver.new_session(NewSessionOptsData::default()).await;

    // Wait for the RunCompleted (the message_complete → FetchState → emit).
    let mut got = None;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if matches!(ev, SessionDriverEvent::RunCompleted { .. }) {
            got = Some(ev);
            break;
        }
    }
    let ev = got.expect("no RunCompleted emitted after message_complete");
    match ev {
        SessionDriverEvent::RunCompleted {
            user_entry_id,
            assistant_entry_id,
            ..
        } => {
            // streaming-turn's prompt_id canonicalizes to PROMPT_0.
            assert_eq!(
                user_entry_id.as_deref(),
                Some("PROMPT_0"),
                "RunCompleted user_entry_id should be the daemon prompt_id"
            );
            assert_eq!(
                assistant_entry_id.as_deref(),
                Some("PROMPT_0"),
                "RunCompleted assistant_entry_id should be the daemon prompt_id"
            );
        }
        _ => unreachable!(),
    }

    // The FetchState effect fetched GET /state (the corpus records /state; the
    // post-message_complete /state is the second recording). Assert the driver
    // made at least one /state call beyond the warm-up one.
    let state_calls = fake
        .recorded_calls()
        .iter()
        .filter(|(m, p)| m == "GET" && p == "/state")
        .count();
    assert!(
        state_calls >= 2,
        "FetchState should have fetched /state after message_complete; /state calls: {}",
        state_calls
    );
}

/// AC.5: a `RefetchQueue` effect (from `pending_turn_input_queued`) emits a
/// `QueueUpdated` carrying the full queue, AND the driver fetched it via `GET
/// /turn/input`. The queue-while-in-flight scenario carries
/// `pending_turn_input_queued`.
#[tokio::test]
async fn refetch_queue_emits_queue_updated() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "queue-while-in-flight");
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "queue-1".into(), 5).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver();
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    let _seed = driver.new_session(NewSessionOptsData::default()).await;

    // Wait for the QueueUpdated (the pending_turn_input_queued → RefetchQueue →
    // GET /turn/input → emit). Timeout so a missing emit fails fast.
    let mut got = None;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if matches!(ev, SessionDriverEvent::QueueUpdated { .. }) {
            got = Some(ev);
            break;
        }
    }
    let ev = got.expect("no QueueUpdated emitted after pending_turn_input_queued");
    match ev {
        SessionDriverEvent::QueueUpdated { messages, .. } => {
            // The canned /turn/input serves one item (q1, "queued-turn-text").
            assert_eq!(
                messages.len(),
                1,
                "QueueUpdated should carry the full queue (1 item)"
            );
            assert_eq!(messages[0].id, "q1");
            assert_eq!(messages[0].text, "queued-turn-text");
        }
        _ => unreachable!(),
    }

    // The RefetchQueue effect fetched GET /turn/input.
    assert!(
        fake.called("GET", "/turn/input"),
        "RefetchQueue should have fetched GET /turn/input; calls: {:?}",
        fake.recorded_calls()
    );
}
