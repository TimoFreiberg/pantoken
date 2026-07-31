//! Deterministic contract scenarios for the polytoken compatibility gaps
//! (issue #135; part of #134, acceptance AC.9).
//!
//! Each scenario exercises a gap identified by the polytoken audit as a
//! **deterministic, strict-fake contract**: the fake daemon consumes `http[]`
//! in one global arrival order, validates request bodies, rejects undeclared
//! requests with 500, and fails the test if any declared expectation is left
//! unconsumed. No canned response is used for scenario-critical endpoints.
//!
//! Scenarios are provider-free and assert Pantoken-boundary observable
//! behavior (typed `SessionDriverEvent`s + the fake's recorded call log), never
//! timing. The four SSE-driven scenarios live in the frozen corpus
//! (`server-rs/tests/corpus/0.5.8/`) and are validated by the corpus loader
//! gate; the HTTP-only scenarios are built in code.
//!
//! **Test isolation:** the spawn-override is process-global, so every test in
//! this file takes the same `OVERRIDE_MUTEX` before setting/clearing it (this
//! serializes the injecting tests within this binary only — cargo runs test
//! binaries in separate processes).

mod support;

use std::sync::Arc;
use std::time::Duration;

use pantoken_protocol::session_driver::{
    HostUiRequest, NotifyLevel, SessionDriverEvent, SessionStatus, SessionUsage,
};
use pantoken_protocol::wire::SessionAction;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use pantoken_server::driver::{NewSessionOptsData, PantokenDriver};
use pantoken_server::polytoken::daemon_client::{
    SpawnDaemonOpts, SpawnedDaemon, clear_spawn_override, set_spawn_override,
};
use pantoken_server::polytoken::driver::PolytokenDriver;

use support::corpus::{self, HttpEntry, ScenarioFile};
use support::fake_daemon;

/// Serializes spawn-override use within this test binary (the override is
/// process-global). Every test below locks this before touching the override.
/// A `tokio::sync::Mutex` (not `parking_lot`) so the guard can be held across
/// the `.await` points inside each test.
static OVERRIDE_MUTEX: Mutex<()> = Mutex::const_new(());

/// The corpus version the harness pins (single frozen version per "pin the
/// corpus" — see PROGRESS.md D20).
const VERSION: &str = "0.5.8";

// ---------------------------------------------------------------------------
// Shared helpers (private in tests/live_path.rs; duplicated here rather than
// refactoring shared support — the shared `support` re-exports tolerate extra
// consumers, but the helpers are deliberately small).
// ---------------------------------------------------------------------------

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
                Ok((
                    SpawnedDaemon {
                        session_id: session_id.clone(),
                        port,
                        auth_token: None,
                    },
                    None,
                ))
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

/// Build a driver pointed at a temp sessions dir (no real daemon needed). Uses
/// the test-only constructor with an injected (empty) login_env so no real
/// shell spawns in CI.
async fn make_driver() -> (PolytokenDriver, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let driver = PolytokenDriver::new_with_login_env(
        dir.path().to_path_buf(),
        "polytoken".into(), // never invoked — the override answers spawns
        false,
        64,
        None,
    )
    .await;
    (driver, dir)
}

/// Subscribe to the driver and collect emitted events into a bounded channel.
/// Returns the subscription id (call `unsubscribe` to stop).
fn collect_events(
    driver: &PolytokenDriver,
    cap: usize,
) -> (usize, tokio::sync::mpsc::Receiver<SessionDriverEvent>) {
    let (tx, rx) = tokio::sync::mpsc::channel(cap);
    let id = driver.subscribe(Box::new(move |ev| {
        let _ = tx.try_send(ev);
    }));
    (id, rx)
}

/// Drain `rx` until the deadline passes, returning events that matched.
/// (Full-window drain — for absence assertions and exact-count windows.)
async fn drain_until(
    rx: &mut tokio::sync::mpsc::Receiver<SessionDriverEvent>,
    deadline: tokio::time::Instant,
    mut predicate: impl FnMut(&SessionDriverEvent) -> bool,
) -> Vec<SessionDriverEvent> {
    let mut seen = Vec::new();
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if predicate(&ev) {
            seen.push(ev);
        }
    }
    seen
}

/// Wait for the first event matching `predicate` (returns on the first match,
/// so presence checks don't burn the whole deadline).
async fn wait_for_event(
    rx: &mut tokio::sync::mpsc::Receiver<SessionDriverEvent>,
    deadline: tokio::time::Instant,
    mut predicate: impl FnMut(&SessionDriverEvent) -> bool,
) -> Vec<SessionDriverEvent> {
    let mut seen = Vec::new();
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if predicate(&ev) {
            seen.push(ev);
            return seen;
        }
    }
    seen
}

/// Poll (bounded) until the fake's recorded call log satisfies `predicate`.
async fn wait_for(
    fake: &fake_daemon::FakeDaemon,
    deadline: tokio::time::Instant,
    mut predicate: impl FnMut(&fake_daemon::FakeDaemon) -> bool,
) {
    loop {
        if predicate(fake) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for a recorded call; calls: {:?}",
            fake.recorded_calls()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ---------------------------------------------------------------------------
// Synthetic scenario builders (public schemas only — provenance
// `synthetic_pantoken_regression`; nothing captured from a live daemon).
// ---------------------------------------------------------------------------

/// The empty contract block for in-code scenarios (no SSE, nothing asserted).
fn empty_contract() -> Value {
    json!({
        "capabilities": [], "events": [], "effects": [],
        "final_session": {"mapped_event_count": 0, "assistant_delta_count": 0,
                          "open_block_count": 0, "tool_input_buffer_empty": true,
                          "turn_error_present": false},
        "required_requests": [], "forbidden_requests": []
    })
}

fn synthetic_scenario(name: &str, http: Vec<HttpEntry>) -> ScenarioFile {
    let body = json!({
        "scenario": name,
        "version": "test",
        "provenance": {"kind": "synthetic_pantoken_regression"},
        "description": "deterministic gap scenario (issue #135)",
        "canonicalization": {"session_id": "SESSION", "prompt_ids": {}, "timestamps": "monotonic-from-T0"},
        "http": http,
        "sse": [],
        "expected_driver_events": empty_contract()
    });
    serde_json::from_value(body).expect("parse synthetic scenario")
}

fn http_entry(method: &str, path: &str, status: i64, response_body: Value) -> HttpEntry {
    HttpEntry {
        method: method.into(),
        path: path.into(),
        request_body: None,
        status,
        response_body: Some(response_body),
    }
}

fn http_entry_with_body(
    method: &str,
    path: &str,
    request_body: Value,
    status: i64,
    response_body: Value,
) -> HttpEntry {
    HttpEntry {
        method: method.into(),
        path: path.into(),
        request_body: Some(request_body),
        status,
        response_body: Some(response_body),
    }
}

/// A minimal `/state` body that fully deserializes as `SessionStateSnapshot`
/// (mirrors `minimal_state_scenario` in live_path.rs).
fn state_body(title: &str) -> Value {
    json!({
        "session_title": title, "todos": [], "flags": [], "env": {},
        "active_facet": "execute", "plugin_config": {}, "project_cwd": "/PROJECT"
    })
}

fn history_body(items: Vec<Value>, revision: i64) -> Value {
    json!({
        "items": items, "offset": 0, "total_projected_items": items.len(),
        "history_revision": revision, "session_id": "SESSION"
    })
}

fn sse_frame(seq: i64, event: Value) -> corpus::SseFrame {
    corpus::SseFrame {
        seq: Some(seq),
        emitted_at: format!("1970-01-01T00:00:{:02}.000Z", seq % 60),
        session_id: "SESSION".into(),
        event,
    }
}

/// The claim request body the driver sends (its OWN pid — known at runtime, so
/// strict body matching can declare it exactly). `process_start_token` is
/// omitted on the wire (skip_serializing_if on the generated type).
fn claim_request_body() -> Value {
    json!({
        "pid": std::process::id() as i64,
        "terminal_label": "pantoken"
    })
}

/// The heartbeat request body the driver sends (same pid trick;
/// `process_start_token` is omitted on the wire).
fn heartbeat_request_body() -> Value {
    json!({
        "lease_id": "lease-1",
        "pid": std::process::id() as i64
    })
}

/// The attach chain every warm `new_session` consumes under the strict fake:
/// `/events` (must be declared — not canned), `/state` (hydration), `/history`
/// (the seed build). `/health`, the lease claim, `/permission-monitor` and
/// `/notification-autodrain` come from the canned bootstrap allowlist.
fn attach_http(history_items: Vec<Value>) -> Vec<HttpEntry> {
    vec![
        http_entry("GET", "/events", 200, Value::Null),
        http_entry("GET", "/state", 200, state_body("main")),
        http_entry("GET", "/history", 200, history_body(history_items, 0)),
    ]
}

// ---------------------------------------------------------------------------
// 1. Attach race — the strict hydration-race contract (AC.3)
// ---------------------------------------------------------------------------

/// The attach-race corpus contract: `/events` connects BEFORE `/state`; a
/// `message_start` buffered while hydration is blocked must be delivered
/// exactly once after warm installation, and the strict attach chain
/// (`/events`, `/state`, `/history`) must all be consumed.
#[tokio::test]
async fn attach_race_corpus_contract_delivers_buffered_event_once() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus::load_named(VERSION, "attach-race");
    let message_start = scenario
        .sse
        .iter()
        .find(|frame| frame.event.get("type").and_then(Value::as_str) == Some("message_start"))
        .cloned()
        .expect("attach-race message_start frame");
    let (fake, race) =
        fake_daemon::spawn_strict_hydration_race(scenario, "attach-race".into(), message_start)
            .await;
    let fake = Arc::new(fake);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    let warm_driver = driver.clone();
    let mut warming =
        tokio::spawn(async move { warm_driver.new_session(NewSessionOptsData::default()).await });
    tokio::time::timeout(Duration::from_secs(2), race.wait_state_requested())
        .await
        .expect("/state entered while hydration blocked");
    tokio::time::timeout(Duration::from_secs(2), race.wait_event_sent())
        .await
        .expect("message_start sent while /state blocked");
    assert!(
        tokio::time::timeout(Duration::from_millis(25), &mut warming)
            .await
            .is_err(),
        "warm installation must remain blocked until the state snapshot returns"
    );
    race.release_state();
    warming
        .await
        .expect("warm task")
        .expect("new_session after releasing hydration");

    // Strict-order proof: /events connected before /state.
    let calls = fake.recorded_calls();
    let events_pos = calls
        .iter()
        .position(|(method, path)| method == "GET" && path == "/events")
        .expect("/events requested");
    let state_pos = calls
        .iter()
        .position(|(method, path)| method == "GET" && path == "/state")
        .expect("/state requested");
    assert!(
        events_pos < state_pos,
        "/events must connect before hydration: {calls:?}"
    );

    // The buffered message_start is delivered exactly once (the seed snapshot
    // is Idle — the /state body carries no turn_in_flight — so only the
    // buffered frame produces a Running update).
    let mut running_updates = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if matches!(
            ev,
            SessionDriverEvent::SessionUpdated { ref snapshot, .. }
                if snapshot.status == SessionStatus::Running
        ) {
            running_updates += 1;
        }
    }
    assert_eq!(
        running_updates, 1,
        "buffered message_start must be delivered exactly once; calls: {calls:?}"
    );
    fake.assert_expectations_consumed()
        .expect("attach-race strict contract consumed");
}

// ---------------------------------------------------------------------------
// 2. Attach-chain auth + malformed-body failures (AC.4)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum AttachFailureKind {
    Claim401,
    Events401,
    State401,
    StateMalformed200,
    PermissionMonitor401,
    PermissionMonitorMalformed200,
    NotificationAutodrain401,
}

impl AttachFailureKind {
    fn scenario(&self) -> ScenarioFile {
        let error_body = json!({"code": "unauthorized", "message": "bad token"});
        let malformed = json!({"malformed": true});
        let http = match self {
            AttachFailureKind::Claim401 => vec![http_entry_with_body(
                "POST",
                "/tui-attachment/claim",
                claim_request_body(),
                401,
                error_body,
            )],
            AttachFailureKind::Events401 => vec![http_entry("GET", "/events", 401, error_body)],
            AttachFailureKind::State401 => vec![
                http_entry("GET", "/events", 200, Value::Null),
                http_entry("GET", "/state", 401, error_body),
            ],
            AttachFailureKind::StateMalformed200 => vec![
                http_entry("GET", "/events", 200, Value::Null),
                http_entry("GET", "/state", 200, malformed),
            ],
            AttachFailureKind::PermissionMonitor401 => vec![
                http_entry("GET", "/events", 200, Value::Null),
                http_entry("GET", "/state", 200, state_body("main")),
                http_entry("GET", "/permission-monitor", 401, error_body),
            ],
            AttachFailureKind::PermissionMonitorMalformed200 => vec![
                http_entry("GET", "/events", 200, Value::Null),
                http_entry("GET", "/state", 200, state_body("main")),
                http_entry("GET", "/permission-monitor", 200, malformed),
            ],
            AttachFailureKind::NotificationAutodrain401 => vec![
                http_entry("GET", "/events", 200, Value::Null),
                http_entry("GET", "/state", 200, state_body("main")),
                http_entry("GET", "/notification-autodrain", 401, error_body),
            ],
        };
        synthetic_scenario(&format!("attach-failure-{self:?}").to_lowercase(), http)
    }
}

/// Every attach-chain failure must reject `new_session` with an error naming
/// the endpoint/phase, install no warm session, make exactly one `/events`
/// call (no reconnect), and release the lease where a lease existed. The
/// malformed-200 variants pin that a malformed SUCCESS body is a compatibility
/// failure, not an empty idle session.
async fn assert_attach_chain_failure(kind: AttachFailureKind) {
    let scenario = kind.scenario();
    let session_id = format!("attach-fail-{:?}", kind);
    let fake =
        Arc::new(fake_daemon::spawn_strict_with_bootstrap(scenario, session_id.clone(), 0).await);
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;

    let error = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect_err("attach-chain failure must reject new_session");

    match &kind {
        AttachFailureKind::Claim401 => {
            assert!(error.contains("lease claim failed"), "{error}");
            assert!(error.contains("401"), "{error}");
            assert_eq!(
                fake.recorded_calls()
                    .iter()
                    .filter(|(m, p)| m == "GET" && p == "/events")
                    .count(),
                0,
                "a failed claim must not connect /events: {:?}",
                fake.recorded_calls()
            );
        }
        AttachFailureKind::Events401 => {
            assert!(error.contains("event subscription failed"), "{error}");
            assert!(error.contains("/events"), "{error}");
            assert!(error.contains("401"), "{error}");
            assert_eq!(
                fake.recorded_calls()
                    .iter()
                    .filter(|(m, p)| m == "GET" && p == "/events")
                    .count(),
                1,
                "a failed subscription must not reconnect"
            );
            assert!(
                fake.called("DELETE", "/tui-attachment/lease-1"),
                "failed subscription must release the lease: {:?}",
                fake.recorded_calls()
            );
        }
        AttachFailureKind::State401 => {
            assert!(
                error.contains("GET /state hydration failed (401)"),
                "{error}"
            );
            assert_eq!(events_call_count(&fake), 1);
            assert!(lease_released(&fake));
        }
        AttachFailureKind::StateMalformed200 => {
            assert!(
                error.contains("GET /state hydration failed (200)"),
                "{error}"
            );
            assert!(error.contains("malformed success body"), "{error}");
            assert_eq!(events_call_count(&fake), 1);
            assert!(lease_released(&fake));
        }
        AttachFailureKind::PermissionMonitor401
        | AttachFailureKind::PermissionMonitorMalformed200 => {
            assert!(
                error.contains("GET /permission-monitor hydration failed"),
                "{error}"
            );
            assert_eq!(events_call_count(&fake), 1);
            assert!(lease_released(&fake));
        }
        AttachFailureKind::NotificationAutodrain401 => {
            assert!(
                error.contains("GET /notification-autodrain hydration failed"),
                "{error}"
            );
            assert_eq!(events_call_count(&fake), 1);
            assert!(lease_released(&fake));
        }
    }

    assert!(
        driver.get_usage(Some(session_id)).is_none(),
        "{kind:?}: failed attach must not install a warm session"
    );
    fake.assert_expectations_consumed()
        .expect("attach-failure contract consumed");
}

fn events_call_count(fake: &fake_daemon::FakeDaemon) -> usize {
    fake.recorded_calls()
        .iter()
        .filter(|(m, p)| m == "GET" && p == "/events")
        .count()
}

fn lease_released(fake: &fake_daemon::FakeDaemon) -> bool {
    fake.called("DELETE", "/tui-attachment/lease-1")
}

#[tokio::test]
async fn auth_failures_and_malformed_bodies_reject_attach() {
    let _guard = OVERRIDE_MUTEX.lock().await;
    for kind in [
        AttachFailureKind::Claim401,
        AttachFailureKind::Events401,
        AttachFailureKind::State401,
        AttachFailureKind::StateMalformed200,
        AttachFailureKind::PermissionMonitor401,
        AttachFailureKind::PermissionMonitorMalformed200,
        AttachFailureKind::NotificationAutodrain401,
    ] {
        assert_attach_chain_failure(kind).await;
    }

    // Seed-path /history failure: the seed build swallows a failed /history
    // into a bare SessionOpened seed (`if let Some(history) = history_res.data`
    // at driver.rs:2437-2455), so a 401 AFTER warm install yields a successful
    // `new_session` whose seed is a single SessionOpened carrying the
    // snapshot. This test pins that behavior as the compatibility contract.
    // (`open_session`'s /history failure is a different path — cold-start
    // fallback — and not covered here.)
    let scenario = synthetic_scenario(
        "attach-history-401",
        vec![
            http_entry("GET", "/events", 200, Value::Null),
            http_entry("GET", "/state", 200, state_body("main")),
            http_entry(
                "GET",
                "/history",
                401,
                json!({"code": "unauthorized", "message": "bad token"}),
            ),
        ],
    );
    let fake = Arc::new(
        fake_daemon::spawn_strict_with_bootstrap(scenario, "attach-history-401".into(), 0).await,
    );
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;
    let seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("a failed seed-path /history must NOT reject attach (pinned swallow)");
    assert_eq!(seed.len(), 1, "bare SessionOpened seed: {seed:?}");
    assert!(
        matches!(seed.first(), Some(SessionDriverEvent::SessionOpened { .. })),
        "seed must begin with SessionOpened"
    );
    assert_eq!(
        fake.recorded_calls()
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/history")
            .count(),
        1,
        "the /history 401 must be consumed by the seed path"
    );
    fake.assert_expectations_consumed()
        .expect("history-401 contract consumed");
}

// ---------------------------------------------------------------------------
// 3. Lease conflict + lease loss (AC.5)
// ---------------------------------------------------------------------------

/// A 409 lease claim surfaces the holder's label + pid + expiry in the
/// `new_session` error (the driver-level assertion targets the label/pid
/// substrings; expiry parsing itself is unit-tested in daemon_client.rs).
///
/// The 409 body deliberately omits a top-level `message` so the daemon
/// client's error path retains the RAW body for `parse_lease_held_error`
/// (a body with `message` would collapse to the message string and lose the
/// holder info).
#[tokio::test]
async fn lease_conflict_surfaces_holder_and_expiry() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = synthetic_scenario(
        "lease-conflict",
        vec![http_entry_with_body(
            "POST",
            "/tui-attachment/claim",
            claim_request_body(),
            409,
            json!({
                "active": {
                    "active_terminal_label": "other-tui",
                    "active_pid": 4242,
                    "last_seen_at": "1970-01-01T00:04:00.000Z",
                    "expires_at": "1970-01-01T00:05:00.000Z"
                }
            }),
        )],
    );
    let fake = Arc::new(
        fake_daemon::spawn_strict_with_bootstrap(scenario, "lease-conflict".into(), 0).await,
    );
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;

    let error = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect_err("a 409 claim must reject attach");
    assert!(error.contains("lease claim failed"), "{error}");
    assert!(
        error.contains("\"other-tui\""),
        "holder label lost: {error}"
    );
    assert!(error.contains("pid 4242"), "holder pid lost: {error}");
    assert!(error.contains("lease expires"), "expiry lost: {error}");
    assert!(
        driver.get_usage(Some("lease-conflict".into())).is_none(),
        "a failed claim must not install a warm session"
    );
    assert_eq!(
        fake.recorded_calls()
            .iter()
            .filter(|(m, p)| m == "POST" && p == "/tui-attachment/claim")
            .count(),
        1,
        "the claim must not be retried by the warm path"
    );
    fake.assert_expectations_consumed()
        .expect("lease-conflict contract consumed");
}

/// Lease loss: a heartbeat 409 (lease expired/stolen) stops the heartbeat task
/// (no further heartbeat POSTs), and the SSE reconnect's synthetic
/// `stream_discontinuity` fires the Reseed recovery (GET /state + GET /history).
///
/// The claim is DECLARED with a 1s heartbeat interval (the canned claim uses
/// 5s) and the heartbeat 409 is declared at the tail of the strict order. The
/// heartbeat task's early ticks 500 (order mismatch, retried every 1s) until
/// the cursor settles on the declared 409 — the SSE reconnect + reseed calls
/// are the only traffic in between, so the 409 lands deterministically within
/// a couple of seconds (the SSE reconnect's backoff grows apart from the
/// 1s heartbeat cadence).
#[tokio::test]
async fn lease_loss_heartbeat_failure_reseeds() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = synthetic_scenario(
        "lease-loss",
        vec![
            http_entry_with_body(
                "POST",
                "/tui-attachment/claim",
                claim_request_body(),
                200,
                json!({
                    "lease_id": "lease-1",
                    "heartbeat_interval_seconds": 1,
                    "expires_after_seconds": 300,
                    "expires_at": "1970-01-01T00:05:00.000Z"
                }),
            ),
            http_entry("GET", "/events", 200, Value::Null),
            http_entry("GET", "/state", 200, state_body("main")),
            http_entry("GET", "/history", 200, history_body(vec![], 0)),
            // Reconnect after the OneShot stream ends.
            http_entry("GET", "/events", 200, Value::Null),
            // The synthetic stream_discontinuity's reseed (state before history).
            http_entry("GET", "/state", 200, state_body("main")),
            http_entry("GET", "/history", 200, history_body(vec![], 1)),
            // The lease-expired/stolen heartbeat: 409 stops the heartbeat task
            // (daemon_client.rs:1664 breaks on 404/409 only).
            http_entry_with_body(
                "POST",
                "/tui-attachment/heartbeat",
                heartbeat_request_body(),
                409,
                json!({"code": "lease_expired", "message": "lease was stolen"}),
            ),
        ],
    );
    let fake =
        Arc::new(fake_daemon::spawn_strict_with_bootstrap(scenario, "lease-loss".into(), 0).await);
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("warm session");

    // The reconnect's synthetic discontinuity → reseed → sessionReset arrives.
    let reset_deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let resets = wait_for_event(&mut rx, reset_deadline, |ev| {
        matches!(ev, SessionDriverEvent::SessionReset { .. })
    })
    .await;
    assert!(
        !resets.is_empty(),
        "the reconnect's stream_discontinuity must reseed (sessionReset): {:?}",
        fake.recorded_calls()
    );

    let calls = fake.recorded_calls();
    // The reseed fetches came AFTER the reconnect (strict order would also fail
    // the test, but assert the observable halves explicitly).
    let events_pos = calls
        .iter()
        .rposition(|(m, p)| m == "GET" && p == "/events")
        .expect("reconnect /events");
    let reseed_state_pos = calls
        .iter()
        .rposition(|(m, p)| m == "GET" && p == "/state")
        .expect("reseed /state");
    assert!(
        events_pos < reseed_state_pos,
        "reseed /state must follow the reconnect: {calls:?}"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/events")
            .count(),
        2,
        "one reconnect: {calls:?}"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/state")
            .count(),
        2,
        "hydration + reseed: {calls:?}"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/history")
            .count(),
        2,
        "seed + reseed: {calls:?}"
    );

    // The heartbeat task stops after its 409. With a 1s interval, "stopped"
    // means the count plateaus for longer than one interval: poll until the
    // count is unchanged across a 1.6s window (the 409 lands a tick or two
    // after the reseed — the early ticks 500 while the strict cursor is still
    // on the attach chain), then assert quiescence for another 2.5s. This is
    // a QUESCENCE check for a detached background task (no handle exists to
    // await), not a timing assertion on event delivery — deliberately
    // bounded, and the strict fake's expectation consumption is the backstop
    // (a live heartbeat would keep 500ing on the exhausted contract).
    let settle_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut last_count = heartbeat_call_count(&fake);
    let mut stable_since: Option<tokio::time::Instant> = None;
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let count = heartbeat_call_count(&fake);
        match stable_since {
            Some(start) if count == last_count => {
                if start.elapsed() >= Duration::from_millis(1600) {
                    break;
                }
            }
            _ => stable_since = Some(tokio::time::Instant::now()),
        }
        last_count = count;
        assert!(
            tokio::time::Instant::now() < settle_deadline,
            "heartbeat count never settled: {} calls so far",
            last_count
        );
    }
    let settled_count = heartbeat_call_count(&fake);
    assert!(
        settled_count >= 1,
        "the heartbeat must have been beating before it stopped; got {settled_count}"
    );
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(
        heartbeat_call_count(&fake),
        settled_count,
        "the heartbeat task must stop after the 409 (no further heartbeats)"
    );
    fake.assert_expectations_consumed()
        .expect("lease-loss contract consumed");
}

fn heartbeat_call_count(fake: &fake_daemon::FakeDaemon) -> usize {
    fake.recorded_calls()
        .iter()
        .filter(|(m, p)| m == "POST" && p == "/tui-attachment/heartbeat")
        .count()
}

// ---------------------------------------------------------------------------
// 4. Queue drain + queue error behavior (AC.6)
// ---------------------------------------------------------------------------

/// A `pending_turn_input_queued` SSE event for populating the local queue state.
fn queue_sse_frame(seq: i64, item_id: &str, content: &str) -> corpus::SseFrame {
    sse_frame(
        seq,
        json!({
            "type": "pending_turn_input_queued",
            "admission_prompt_id": "PROMPT_0",
            "content": content,
            "item_id": item_id,
            "queue_revision": seq
        }),
    )
}

/// Wait for a `QueueUpdated` event (emitted by the `QueueAdd` effect when the
/// SSE consumer processes `pending_turn_input_queued`). Only after the local
/// queue is populated can `clear_queue` return the expected texts.
async fn wait_for_queue_updated(rx: &mut tokio::sync::mpsc::Receiver<SessionDriverEvent>) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if matches!(ev, SessionDriverEvent::QueueUpdated { .. }) {
            return;
        }
    }
    panic!("no QueueUpdated emitted after pending_turn_input_queued");
}

/// A 3-item queue drains fully (all texts returned, exactly one DELETE per
/// item). The local queue is populated from `pending_turn_input_queued` SSE
/// events (no `GET /turn/input` — the live daemon 0.5.8+ doesn't expose it).
/// Error variants are pinned AS THE CODE BEHAVES (driver.rs returns
/// `ClearQueueResult`, not `Result`):
///   * empty queue → an EMPTY result (no SSE events → no local queue items);
///   * `DELETE` 500 on the second dequeue → the DELETE drain stops while the
///     result still carries the local queue's texts (partial drain, no error
///     propagation);
///   * `POST /prompt` 409 → `prompt` returns Err carrying the daemon's public
///     code/message (this one IS propagated).
#[tokio::test]
async fn multi_item_queue_drain_and_queue_errors() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    // (a) Happy full drain.
    {
        let mut scenario = synthetic_scenario(
            "queue-drain",
            vec![
                http_entry("GET", "/events", 200, Value::Null),
                http_entry("GET", "/state", 200, state_body("main")),
                http_entry("GET", "/history", 200, history_body(vec![], 0)),
                http_entry("DELETE", "/turn/input/newest", 200, json!({"ok": true})),
                http_entry("DELETE", "/turn/input/newest", 200, json!({"ok": true})),
                http_entry("DELETE", "/turn/input/newest", 200, json!({"ok": true})),
            ],
        );
        // Populate the local queue via SSE events (no GET /turn/input).
        scenario.sse = vec![
            queue_sse_frame(0, "q1", "first text"),
            queue_sse_frame(1, "q2", "second text"),
            queue_sse_frame(2, "q3", "third text"),
        ];
        let fake = Arc::new(
            fake_daemon::spawn_strict_with_bootstrap(scenario, "queue-drain".into(), 0).await,
        );
        let _ovr = OverrideGuard::install(fake.clone());
        let (driver, _dir) = make_driver().await;
        let (_sub_id, mut rx) = collect_events(&driver, 256);
        driver
            .new_session(NewSessionOptsData::default())
            .await
            .expect("warm session");
        // Wait for the local queue to be populated by the QueueAdd effects.
        wait_for_queue_updated(&mut rx).await;
        // Drain any remaining QueueUpdated events (one per QueueAdd).
        wait_for_queue_updated(&mut rx).await;
        wait_for_queue_updated(&mut rx).await;
        let result = driver.clear_queue(Some("queue-drain".into())).await;
        assert_eq!(
            result.steering,
            vec![
                "first text".to_string(),
                "second text".to_string(),
                "third text".to_string()
            ],
            "all queued texts must be returned"
        );
        assert_eq!(
            fake.recorded_calls()
                .iter()
                .filter(|(m, p)| m == "DELETE" && p == "/turn/input/newest")
                .count(),
            3,
            "exactly one dequeue per item: {:?}",
            fake.recorded_calls()
        );
        fake.assert_expectations_consumed()
            .expect("queue-drain contract consumed");
    }

    // (b) Empty queue → empty result, no deletes (no SSE events populated
    // the local queue, so clear_queue has nothing to return or drain).
    {
        let scenario = synthetic_scenario(
            "queue-empty",
            vec![
                http_entry("GET", "/events", 200, Value::Null),
                http_entry("GET", "/state", 200, state_body("main")),
                http_entry("GET", "/history", 200, history_body(vec![], 0)),
            ],
        );
        let fake = Arc::new(
            fake_daemon::spawn_strict_with_bootstrap(scenario, "queue-empty".into(), 0).await,
        );
        let _ovr = OverrideGuard::install(fake.clone());
        let (driver, _dir) = make_driver().await;
        driver
            .new_session(NewSessionOptsData::default())
            .await
            .expect("warm session");
        let result = driver.clear_queue(Some("queue-empty".into())).await;
        assert!(
            result.steering.is_empty(),
            "empty local queue must yield an empty ClearQueueResult: {:?}",
            result
        );
        assert_eq!(
            fake.recorded_calls()
                .iter()
                .filter(|(m, p)| m == "DELETE" && p == "/turn/input/newest")
                .count(),
            0,
            "no deletes without local queue items"
        );
        fake.assert_expectations_consumed()
            .expect("queue-empty contract consumed");
    }

    // (c) Dequeue failure on the 2nd item → drain stops, texts still returned.
    {
        let mut scenario = synthetic_scenario(
            "queue-dequeue-error",
            vec![
                http_entry("GET", "/events", 200, Value::Null),
                http_entry("GET", "/state", 200, state_body("main")),
                http_entry("GET", "/history", 200, history_body(vec![], 0)),
                http_entry("DELETE", "/turn/input/newest", 200, json!({"ok": true})),
                http_entry(
                    "DELETE",
                    "/turn/input/newest",
                    500,
                    json!({"code": "dequeue_failed", "message": "dequeue exploded"}),
                ),
            ],
        );
        // Populate the local queue via SSE events.
        scenario.sse = vec![
            queue_sse_frame(0, "q1", "first text"),
            queue_sse_frame(1, "q2", "second text"),
            queue_sse_frame(2, "q3", "third text"),
        ];
        let fake = Arc::new(
            fake_daemon::spawn_strict_with_bootstrap(scenario, "queue-dequeue-error".into(), 0)
                .await,
        );
        let _ovr = OverrideGuard::install(fake.clone());
        let (driver, _dir) = make_driver().await;
        let (_sub_id, mut rx) = collect_events(&driver, 256);
        driver
            .new_session(NewSessionOptsData::default())
            .await
            .expect("warm session");
        // Wait for the local queue to be populated by the QueueAdd effects.
        wait_for_queue_updated(&mut rx).await;
        wait_for_queue_updated(&mut rx).await;
        wait_for_queue_updated(&mut rx).await;
        let result = driver.clear_queue(Some("queue-dequeue-error".into())).await;
        // The returned texts come from the LOCAL QUEUE, not the deletes, so
        // all 3 are returned despite the failed dequeue; the DELETE drain
        // itself stops at the failure.
        assert_eq!(
            result.steering.len(),
            3,
            "clear_queue returns the local queue's texts even when the drain stops early: {:?}",
            result
        );
        assert_eq!(
            fake.recorded_calls()
                .iter()
                .filter(|(m, p)| m == "DELETE" && p == "/turn/input/newest")
                .count(),
            2,
            "the DELETE drain must stop at the failed dequeue: {:?}",
            fake.recorded_calls()
        );
        fake.assert_expectations_consumed()
            .expect("queue-dequeue-error contract consumed");
    }

    // (d) POST /prompt 409 → Err carries the daemon's public code/message.
    {
        let scenario = synthetic_scenario(
            "prompt-busy-409",
            vec![
                http_entry("GET", "/events", 200, Value::Null),
                http_entry("GET", "/state", 200, state_body("main")),
                http_entry("GET", "/history", 200, history_body(vec![], 0)),
                http_entry_with_body(
                    "POST",
                    "/prompt",
                    json!({"content": "hello"}),
                    409,
                    json!({"code": "turn_busy", "message": "another turn is running"}),
                ),
            ],
        );
        let fake = Arc::new(
            fake_daemon::spawn_strict_with_bootstrap(scenario, "prompt-busy-409".into(), 0).await,
        );
        let _ovr = OverrideGuard::install(fake.clone());
        let (driver, _dir) = make_driver().await;
        driver
            .new_session(NewSessionOptsData::default())
            .await
            .expect("warm session");
        let error = driver
            .prompt(
                "hello".into(),
                None,
                Some("prompt-busy-409".into()),
                vec![],
                None,
            )
            .await
            .expect_err("a 409 prompt must fail");
        assert!(error.contains("another turn is running"), "{error}");
        assert!(error.contains("turn_busy"), "{error}");
        fake.assert_expectations_consumed()
            .expect("prompt-busy-409 contract consumed");
    }
}

// ---------------------------------------------------------------------------
// 5. Rewind → reseed contract (AC.7)
// ---------------------------------------------------------------------------

/// `session_rewound` → Reseed is pinned by the corpus contract
/// (`rewind-reseed.json` passes the corpus gate). This live strict test drives
/// `branch_from` against the same file: the post-rewind refresh (GET /state
/// then GET /history at driver.rs:2508-2528) is recorded, the editor text is
/// preserved, and the rewind request carries exactly the three REWIND_DOMAINS.
///
/// The live run uses the gated fake and pushes NO frames: folding
/// `session_rewound` at attach time would fire a reseed that RACES the
/// seed-path /history under strict global ordering. The corpus gate (pure
/// fold, no HTTP) pins the SSE contract; this test pins the HTTP side
/// deterministically, and the held-open gated stream avoids the OneShot
/// reconnect loop entirely.
#[tokio::test]
async fn rewind_reseed_corpus_contract() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus::load_named(VERSION, "rewind-reseed");
    let (fake, _gate) = fake_daemon::spawn_strict_gated(scenario, "rewind-reseed".into()).await;
    let fake = Arc::new(fake);
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;

    driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("warm session");
    let result = driver
        .branch_from("PROMPT_0".into(), false, Some("rewind-reseed".into()))
        .await
        .expect("accepted rewind");

    assert_eq!(
        result.editor_text.as_deref(),
        Some("preserve this prompt"),
        "the pre-rewind editor text must be preserved"
    );
    assert!(
        result.seed.iter().any(|event| matches!(event,
            SessionDriverEvent::UserMessage { id, text, .. }
                if id == "PROMPT_0" && text == "preserve this prompt"
        )),
        "the reseed must contain the post-rewind target prompt: {:?}",
        result.seed
    );

    let rewind = fake
        .recorded_request_bodies()
        .into_iter()
        .find(|(method, path, _)| method == "POST" && path == "/rewind")
        .expect("rewind request");
    let request: Value = serde_json::from_str(&rewind.2).expect("rewind JSON");
    assert_eq!(request["to_prompt_id"], "PROMPT_0");
    assert_eq!(
        request["domains"],
        json!(["conversation", "todos", "flags"]),
        "the rewind body must carry exactly the three REWIND_DOMAINS"
    );

    let calls = fake.recorded_calls();
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "POST" && p == "/rewind")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/state")
            .count(),
        2,
        "attach hydration + post-rewind refresh: {calls:?}"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/history")
            .count(),
        3,
        "seed + pre-rewind lookup + post-rewind refresh: {calls:?}"
    );
    fake.assert_expectations_consumed()
        .expect("rewind-reseed contract consumed");
}

// ---------------------------------------------------------------------------
// 6. Reconnect discontinuity → reseed → continues (AC.8)
// ---------------------------------------------------------------------------

/// The SSE subscriber synthesizes a `stream_discontinuity` on reconnect
/// (daemon_client.rs:2649-2667). The driver must reseed (GET /state then
/// GET /history) and then keep delivering: a pushed tail `message_complete`
/// after the reconnect still produces its RunCompleted.
///
/// Driven through the gated strict fake: frames are pushed AFTER the warm
/// attach completes (never racing the seed fetch), and `close()` ends the
/// stream so the client's reconnect path fires with its synthetic
/// discontinuity.
#[tokio::test]
async fn reconnect_discontinuity_reseeds_and_continues() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let mut scenario = corpus::load_named(VERSION, "reconnect-stream-discontinuity");
    // The corpus file's http[] is a capture-style recording; rewrite it into
    // the driver's real call order for the strict fake. The SSE content stays
    // untouched (pushed through the gate below).
    scenario.http = vec![
        http_entry("GET", "/events", 200, Value::Null),
        http_entry("GET", "/state", 200, state_body("main")),
        http_entry("GET", "/history", 200, history_body(vec![], 0)),
        // Reseed from the daemon-emitted stream_discontinuity (state, history).
        http_entry("GET", "/state", 200, state_body("main")),
        http_entry("GET", "/history", 200, history_body(vec![], 1)),
        // FetchState after the pre-gap message_complete.
        http_entry("GET", "/state", 200, state_body("main")),
        // The reconnect itself (a second GET /events — the OneShot stream
        // ends after its frames, so the client reconnects).
        http_entry("GET", "/events", 200, Value::Null),
        // Reseed from the synthetic reconnect discontinuity.
        http_entry("GET", "/state", 200, state_body("main")),
        http_entry("GET", "/history", 200, history_body(vec![], 2)),
        // FetchState after the post-reconnect message_complete.
        http_entry("GET", "/state", 200, state_body("main")),
    ];
    let (fake, gate) =
        fake_daemon::spawn_strict_gated(scenario, "reconnect-discontinuity".into()).await;
    let fake = Arc::new(fake);
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("warm session");

    // Pre-gap frames: message_start → content blocks → the daemon-emitted
    // stream_discontinuity (reseed #1), then message_complete (FetchState).
    let pre_gap = corpus::load_named(VERSION, "reconnect-stream-discontinuity");
    for frame in pre_gap.sse.iter().take(4) {
        gate.push(frame.clone()).await.expect("push pre-gap frame");
    }
    // Wait for reseed #1's fetches (the second GET /history after attach).
    wait_for(
        &fake,
        tokio::time::Instant::now() + Duration::from_secs(5),
        |f| {
            f.recorded_calls()
                .iter()
                .filter(|(m, p)| m == "GET" && p == "/history")
                .count()
                >= 2
        },
    )
    .await;
    gate.push(pre_gap.sse[4].clone())
        .await
        .expect("push message_complete");

    // The pre-gap turn completes (RunCompleted #1).
    let completed_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let completed = wait_for_event(&mut rx, completed_deadline, |ev| {
        matches!(ev, SessionDriverEvent::RunCompleted { .. })
    })
    .await;
    assert!(!completed.is_empty(), "pre-gap RunCompleted must arrive");

    // End the stream → the client reconnects → the synthetic discontinuity
    // fires reseed #2.
    gate.close();
    let reset_deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let resets = wait_for_event(&mut rx, reset_deadline, |ev| {
        matches!(ev, SessionDriverEvent::SessionReset { .. })
    })
    .await;
    assert!(
        !resets.is_empty(),
        "the reconnect's synthetic discontinuity must reseed; calls: {:?}",
        fake.recorded_calls()
    );

    // The reconnect's reseed fetches follow the second GET /events.
    let calls = fake.recorded_calls();
    let second_events = calls
        .iter()
        .rposition(|(m, p)| m == "GET" && p == "/events")
        .expect("reconnect /events");
    let reseed_state = calls
        .iter()
        .rposition(|(m, p)| m == "GET" && p == "/state")
        .expect("reseed /state");
    assert!(
        second_events < reseed_state,
        "reseed /state must follow the reconnect: {calls:?}"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/events")
            .count(),
        2,
        "attach + reconnect: {calls:?}"
    );

    // Delivery continues after the reconnect: the pushed tail message_complete
    // still yields RunCompleted #2.
    let post_gap_complete = pre_gap.sse[4].clone();
    gate.push(post_gap_complete).await.expect("push tail frame");
    let tail_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let tail_completed = wait_for_event(&mut rx, tail_deadline, |ev| {
        matches!(ev, SessionDriverEvent::RunCompleted { .. })
    })
    .await;
    assert!(
        !tail_completed.is_empty(),
        "delivery must continue after the reseed (RunCompleted #2)"
    );
    fake.assert_expectations_consumed()
        .expect("reconnect-discontinuity contract consumed");
}

/// In-code variant: the stream is interrupted mid-`tool_call` (a partial tool
/// input buffer is in the accumulator when the disconnect happens). The
/// reseed must leave a CLEAN accumulator: the post-reconnect `tool_call` input
/// is built from the fresh deltas only, never the stale partial text.
#[tokio::test]
async fn reconnect_tool_call_reseeds_to_clean_accumulator() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = synthetic_scenario(
        "reconnect-tool-interrupt",
        vec![
            http_entry("GET", "/events", 200, Value::Null),
            http_entry("GET", "/state", 200, state_body("main")),
            http_entry("GET", "/history", 200, history_body(vec![], 0)),
            // The reconnect itself (the stream is closed below; the client's
            // SSE loop reconnects and emits the synthetic discontinuity).
            http_entry("GET", "/events", 200, Value::Null),
            // Reseed from the synthetic reconnect discontinuity.
            http_entry("GET", "/state", 200, state_body("main")),
            http_entry(
                "GET",
                "/history",
                200,
                history_body(
                    vec![json!({
                        "type": "user",
                        "prompt_id": "PROMPT_0",
                        "content": "recovered turn"
                    })],
                    1,
                ),
            ),
        ],
    );
    let (fake, gate) =
        fake_daemon::spawn_strict_gated(scenario, "reconnect-tool-interrupt".into()).await;
    let fake = Arc::new(fake);
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("warm session");

    // Interrupted tool call: the tool_use block starts and one partial input
    // delta lands before the disconnect.
    gate.push(sse_frame(
        1,
        json!({"type": "message_start", "prompt_id": "PROMPT_0"}),
    ))
    .await
    .expect("push message_start");
    gate.push(sse_frame(
        2,
        json!({
            "type": "content_block_start",
            "prompt_id": "PROMPT_0",
            "block_index": 0,
            "block_type": {"type": "tool_use", "id": "tu1", "name": "bash"}
        }),
    ))
    .await
    .expect("push tool_use block start");
    gate.push(sse_frame(
        3,
        json!({
            "type": "content_block_delta",
            "prompt_id": "PROMPT_0",
            "block_index": 0,
            "delta": {"type": "tool_use_input", "partial_json": "{\"stale\":"}
        }),
    ))
    .await
    .expect("push partial tool input");

    // No ToolStarted yet — the tool_call event never arrived before the gap.
    tokio::time::sleep(Duration::from_millis(150)).await;
    // (rx has only the buffered message_start SessionUpdated; nothing else.)

    // Disconnect → reconnect → synthetic discontinuity → reseed. The reseed
    // history replay carries a user row; the stale tool state must be gone.
    gate.close();
    let reset_deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut saw_reset = false;
    let mut saw_recovered_user = false;
    while let Ok(Some(ev)) = tokio::time::timeout_at(reset_deadline, rx.recv()).await {
        match &ev {
            SessionDriverEvent::SessionReset { .. } => saw_reset = true,
            SessionDriverEvent::UserMessage { text, .. } if text == "recovered turn" => {
                saw_recovered_user = true
            }
            _ => {}
        }
        if saw_reset && saw_recovered_user {
            break;
        }
    }
    assert!(saw_reset, "the reconnect must reseed");
    assert!(
        saw_recovered_user,
        "the reseed replay must contain the recovered transcript row"
    );

    // A fresh tool sequence after the reseed: the accumulator must be CLEAN —
    // the new input delta alone (no stale prefix) parses into the ToolStarted
    // input.
    gate.push(sse_frame(
        4,
        json!({
            "type": "content_block_start",
            "prompt_id": "PROMPT_0",
            "block_index": 0,
            "block_type": {"type": "tool_use", "id": "tu2", "name": "bash"}
        }),
    ))
    .await
    .expect("push fresh tool_use block");
    gate.push(sse_frame(
        5,
        json!({
            "type": "content_block_delta",
            "prompt_id": "PROMPT_0",
            "block_index": 0,
            "delta": {"type": "tool_use_input", "partial_json": "{\"fresh\":\"clean\"}"}
        }),
    ))
    .await
    .expect("push fresh tool input");
    gate.push(sse_frame(
        6,
        json!({"type": "tool_call", "call_id": "call2", "name": "bash", "prompt_id": "PROMPT_0"}),
    ))
    .await
    .expect("push tool_call");

    let tool_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let tool_starts = drain_until(&mut rx, tool_deadline, |ev| {
        matches!(ev, SessionDriverEvent::ToolStarted { .. })
    })
    .await;
    assert_eq!(
        tool_starts.len(),
        1,
        "exactly one ToolStarted after the reseed"
    );
    match &tool_starts[0] {
        SessionDriverEvent::ToolStarted { call_id, input, .. } => {
            assert_eq!(call_id, "call2");
            assert_eq!(
                input.as_ref(),
                Some(&json!({"fresh": "clean"})),
                "the reseed must clear the stale tool input buffer"
            );
        }
        _ => unreachable!("filtered above"),
    }
    fake.assert_expectations_consumed()
        .expect("reconnect-tool-interrupt contract consumed");
}

// ---------------------------------------------------------------------------
// 7. History hydration covers every projected kind (AC.9)
// ---------------------------------------------------------------------------

/// A `/history` body containing EVERY kind `history_seed.rs` projects must
/// seed the correct transcript rows and silently skip the metadata-only kinds
/// without crashing (match arms at history_seed.rs:354-552).
#[tokio::test]
async fn history_hydration_covers_every_projected_kind() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let items = vec![
        // Renderable kinds.
        json!({
            "type": "user", "prompt_id": "prompt-a",
            "content": "first user turn",
            "emitted_at": "1970-01-01T00:00:01.000Z"
        }),
        json!({
            "type": "assistant", "prompt_id": "prompt-a",
            "emitted_at": "1970-01-01T00:00:02.000Z",
            "blocks": [
                {"type": "text", "text": "text reply"},
                {"type": "thinking", "text": "hidden reasoning"},
                {"type": "tool_use", "id": "call-1", "name": "bash",
                 "input": {"command": "ls -la"}}
            ]
        }),
        json!({
            "type": "tool_result", "call_id": "call-1",
            "is_error": false, "content": {"text": "done"},
            "emitted_at": "1970-01-01T00:00:03.000Z"
        }),
        json!({
            "type": "tool_result", "call_id": "call-err",
            "is_error": true, "content": {"text": "boom"},
            "emitted_at": "1970-01-01T00:00:04.000Z"
        }),
        // Metadata kinds with transcript representations.
        json!({
            "type": "session_lifecycle", "text": "session resumed",
            "emitted_at": "1970-01-01T00:00:05.000Z"
        }),
        json!({
            "type": "model_switch",
            "to_model": "openai/gpt-5", "to_reasoning_effort": "high",
            "emitted_at": "1970-01-01T00:00:06.000Z"
        }),
        json!({
            "type": "facet_switch", "to_facet": "plan",
            "emitted_at": "1970-01-01T00:00:07.000Z"
        }),
        json!({
            "type": "compaction_fencepost", "compaction_id": "c1",
            "summary": "Context compacted to fit",
            "emitted_at": "1970-01-01T00:00:08.000Z"
        }),
        json!({
            "type": "system_reminder", "slug": "repository-status",
            "body": "Reminder body text",
            "reason": {"type": "session_start"},
            "emitted_at": "1970-01-01T00:00:09.000Z"
        }),
        json!({
            "type": "context_cleared",
            "emitted_at": "1970-01-01T00:00:10.000Z"
        }),
        // Metadata-only kinds: no transcript rows.
        json!({"type": "state_update", "emitted_at": "1970-01-01T00:00:11.000Z"}),
        json!({"type": "classifier_decision", "emitted_at": "1970-01-01T00:00:12.000Z"}),
        json!({"type": "image_reference", "emitted_at": "1970-01-01T00:00:13.000Z"}),
    ];

    let scenario = synthetic_scenario(
        "history-all-kinds",
        vec![
            http_entry("GET", "/events", 200, Value::Null),
            http_entry("GET", "/state", 200, state_body("main")),
            http_entry("GET", "/history", 200, history_body(items, 1)),
        ],
    );
    let fake = Arc::new(
        fake_daemon::spawn_strict_with_bootstrap(scenario, "history-all-kinds".into(), 0).await,
    );
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;

    let seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("warm session with every projected history kind");

    // SessionOpened leads the seed.
    assert!(
        matches!(seed.first(), Some(SessionDriverEvent::SessionOpened { .. })),
        "seed must begin with SessionOpened"
    );

    // user → UserMessage carrying the prompt id + text.
    assert!(
        seed.iter().any(|event| matches!(event,
            SessionDriverEvent::UserMessage { id, text, entry_id, .. }
                if id == "prompt-a" && text == "first user turn"
                   && entry_id.as_deref() == Some("prompt-a")
        )),
        "user kind must seed a UserMessage: {:?}",
        seed
    );

    // assistant → AssistantDelta for text AND thinking blocks, and ToolStarted
    // for the tool_use block.
    let text_deltas: Vec<_> = seed
        .iter()
        .filter_map(|ev| match ev {
            SessionDriverEvent::AssistantDelta {
                text,
                channel,
                entry_id,
                ..
            } => Some((text.clone(), channel.clone(), entry_id.clone())),
            _ => None,
        })
        .collect();
    assert!(
        text_deltas.iter().any(|(text, channel, entry)| {
            text == "text reply"
                && channel.as_ref().is_some_and(|c| {
                    matches!(
                        c,
                        pantoken_protocol::session_driver::AssistantDeltaChannel::Text
                    )
                })
                && entry.as_deref() == Some("prompt-a")
        }),
        "assistant text block must seed an AssistantDelta: {text_deltas:?}"
    );
    assert!(
        text_deltas.iter().any(|(text, channel, _)| {
            text == "hidden reasoning"
                && channel.as_ref().is_some_and(|c| {
                    matches!(
                        c,
                        pantoken_protocol::session_driver::AssistantDeltaChannel::Thinking
                    )
                })
        }),
        "assistant thinking block must seed an AssistantDelta: {text_deltas:?}"
    );
    assert!(
        seed.iter().any(|event| matches!(event,
            SessionDriverEvent::ToolStarted { tool_name, call_id, input, .. }
                if tool_name == "bash" && call_id == "call-1"
                   && input.as_ref() == Some(&json!({"command": "ls -la"}))
        )),
        "assistant tool_use block must seed a ToolStarted: {:?}",
        seed
    );

    // tool_result → ToolFinished paired with the ToolStarted by call_id
    // (success + error variants).
    let finished: Vec<_> = seed
        .iter()
        .filter_map(|ev| match ev {
            SessionDriverEvent::ToolFinished {
                call_id,
                success,
                output,
                interrupted,
                ..
            } => Some((call_id.clone(), *success, output.clone(), *interrupted)),
            _ => None,
        })
        .collect();
    assert!(
        finished
            .iter()
            .any(|(call_id, success, output, _)| call_id == "call-1"
                && *success
                && output.as_ref().and_then(|v| v.as_str()) == Some("done")),
        "tool_result must seed a ToolFinished for call-1: {finished:?}"
    );
    assert!(
        finished
            .iter()
            .any(|(call_id, success, output, _)| call_id == "call-err"
                && !*success
                && output.as_ref().and_then(|v| v.as_str()) == Some("boom")),
        "an error tool_result must seed a failed ToolFinished: {finished:?}"
    );
    // The orphan settlement must NOT fire for call-1 (its result is present).
    assert!(
        !finished
            .iter()
            .any(|(call_id, _, _, interrupted)| call_id == "call-1" && *interrupted == Some(true)),
        "call-1 has its result; no interrupted settlement: {finished:?}"
    );

    // Metadata kinds → the exact history_seed mapping.
    let custom: Vec<_> = seed
        .iter()
        .filter_map(|ev| match ev {
            SessionDriverEvent::CustomMessage {
                custom_type,
                text,
                display,
                ..
            } => Some((custom_type.clone(), text.clone(), *display)),
            _ => None,
        })
        .collect();
    assert!(
        custom
            .iter()
            .any(|(t, text, display)| t == "lifecycle" && !*display && text == "session resumed"),
        "session_lifecycle must seed a non-display CustomMessage: {custom:?}"
    );
    assert!(
        custom.iter().any(|(t, text, display)| t == "compaction"
            && *display
            && text == "Context compacted to fit"),
        "compaction_fencepost must seed a display CustomMessage: {custom:?}"
    );
    assert!(
        custom
            .iter()
            .any(|(t, text, display)| t == "context-cleared"
                && *display
                && text == "Context cleared"),
        "context_cleared must seed a display CustomMessage: {custom:?}"
    );
    assert!(
        custom
            .iter()
            .any(|(t, _, display)| t == "repository-status" && !*display),
        "system_reminder must seed a non-display CustomMessage keyed by slug: {custom:?}"
    );

    // model_switch (with a target) → SessionUpdated carrying the config.
    assert!(
        seed.iter().any(|event| matches!(event,
            SessionDriverEvent::SessionUpdated { snapshot, .. }
                if snapshot.config.as_ref().is_some_and(|c|
                       c.model_id.as_deref() == Some("openai/gpt-5")
                    && c.thinking_level.as_deref() == Some("high"))
        )),
        "model_switch must seed a SessionUpdated with the new config: {:?}",
        seed
    );
    // facet_switch (with a target) → SessionUpdated carrying the facet.
    assert!(
        seed.iter().any(|event| matches!(event,
            SessionDriverEvent::SessionUpdated { snapshot, .. }
                if snapshot.facet.as_deref() == Some("plan")
        )),
        "facet_switch must seed a SessionUpdated with the new facet: {:?}",
        seed
    );

    // Metadata-only kinds produce NO rows — and nothing else leaked: the seed
    // is exactly the 14 events above (SessionOpened + 1 user + 2 assistant
    // deltas + 1 ToolStarted + 2 ToolFinished + 4 CustomMessages + 2
    // SessionUpdateds + the trailing re-assert SessionUpdated that
    // build_branch_seed appends). No state_update/classifier_decision/
    // image_reference row, no orphan settlement (call-1 has its result).
    assert_eq!(
        seed.len(),
        14,
        "every projected kind must fold without crashes or leaks: {seed:?}"
    );
    assert!(
        !seed.iter().any(|event| matches!(
            event,
            SessionDriverEvent::SessionClosed { .. }
                | SessionDriverEvent::QueueUpdated { .. }
                | SessionDriverEvent::HostUiRequest { .. }
        )),
        "unexpected event kinds in the seed: {seed:?}"
    );

    fake.assert_expectations_consumed()
        .expect("history-all-kinds contract consumed");
}

// ---------------------------------------------------------------------------
// 8. State invalidation domains + authoritative refetch (AC.10)
// ---------------------------------------------------------------------------

/// `session_state_changed` triggers an authoritative `GET /state` (the emitted
/// SessionUpdated reflects the refreshed state); `context_cleared` triggers
/// the reseed fetches; and `branch_from`'s rewind body carries exactly the
/// three `REWIND_DOMAINS` (`["conversation", "todos", "flags"]`).
#[tokio::test]
async fn state_invalidation_domains_and_authoritative_refetch() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus::load_named(VERSION, "state-invalidation");
    let (fake, gate) = fake_daemon::spawn_strict_gated(scenario, "state-invalidation".into()).await;
    let fake = Arc::new(fake);
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("warm session");

    // session_state_changed → authoritative GET /state → SessionUpdated with
    // the REFRESHED title ("after-change", served by the 4th http[] entry).
    gate.push(sse_frame(
        1,
        json!({"type": "session_state_changed", "domains": ["todos"]}),
    ))
    .await
    .expect("push session_state_changed");
    wait_for(
        &fake,
        tokio::time::Instant::now() + Duration::from_secs(5),
        |f| {
            f.recorded_calls()
                .iter()
                .filter(|(m, p)| m == "GET" && p == "/state")
                .count()
                >= 2
        },
    )
    .await;
    let updated = wait_for_event(
        &mut rx,
        tokio::time::Instant::now() + Duration::from_secs(2),
        |ev| {
            matches!(ev, SessionDriverEvent::SessionUpdated { snapshot, .. }
                if snapshot.title == "after-change")
        },
    )
    .await;
    assert!(
        !updated.is_empty(),
        "session_state_changed must refetch /state and emit the refreshed snapshot; calls: {:?}",
        fake.recorded_calls()
    );

    // context_cleared → Reseed (GET /state then GET /history) → sessionReset +
    // the surviving turn replay.
    gate.push(sse_frame(
        2,
        json!({"type": "context_cleared", "facet": "execute"}),
    ))
    .await
    .expect("push context_cleared");
    let reseed_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut saw_reset = false;
    let mut saw_survivor = false;
    while let Ok(Some(ev)) = tokio::time::timeout_at(reseed_deadline, rx.recv()).await {
        match &ev {
            SessionDriverEvent::SessionReset { .. } => saw_reset = true,
            SessionDriverEvent::UserMessage { text, .. } if text == "surviving turn" => {
                saw_survivor = true
            }
            _ => {}
        }
        if saw_reset && saw_survivor {
            break;
        }
    }
    assert!(
        saw_reset,
        "context_cleared must reseed; calls: {:?}",
        fake.recorded_calls()
    );
    assert!(saw_survivor, "the reseed must replay the surviving turn");

    let calls = fake.recorded_calls();
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/state")
            .count(),
        3,
        "hydration + invalidation refetch + reseed: {calls:?}"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/history")
            .count(),
        2,
        "seed + reseed: {calls:?}"
    );

    // The rewind-domain contract: the branch body carries exactly the three
    // domains (mirrors branch_rewind_acceptance_preserves_prompt_domains_and_reseeds).
    let result = driver
        .branch_from("PROMPT_0".into(), false, Some("state-invalidation".into()))
        .await
        .expect("branch_from after the invalidation flow");
    assert_eq!(
        result.editor_text.as_deref(),
        Some("surviving turn"),
        "the rewind prefill must come from the reseeded transcript"
    );
    let rewind = fake
        .recorded_request_bodies()
        .into_iter()
        .find(|(method, path, _)| method == "POST" && path == "/rewind")
        .expect("rewind request");
    let request: Value = serde_json::from_str(&rewind.2).expect("rewind JSON");
    assert_eq!(
        request["domains"],
        json!(["conversation", "todos", "flags"]),
        "REWIND_DOMAINS must be exactly conversation/todos/flags"
    );
    assert_eq!(request["to_prompt_id"], "PROMPT_0");

    let calls = fake.recorded_calls();
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/state")
            .count(),
        4,
        "hydration + refetch + reseed + post-rewind refresh: {calls:?}"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/history")
            .count(),
        4,
        "seed + reseed + pre-rewind lookup + post-rewind refresh: {calls:?}"
    );
    fake.assert_expectations_consumed()
        .expect("state-invalidation contract consumed");
}

// ---------------------------------------------------------------------------
// 9. Current-event disposition groups (AC.10)
// ---------------------------------------------------------------------------

/// One event per disposition group, asserted through the live driver:
///   * heartbeat → NO driver event and NO fetch (intentional no-op);
///   * message_start → SessionUpdated;
///   * session_state_changed → authoritative GET /state;
///   * model_error → warning Notify carrying the daemon message;
///   * stream_discontinuity → reseed fetches (GET /state + GET /history).
/// Strict expectation consumption proves the recorded-call sequence matches
/// the declared http[] exactly (no extra, no missing).
#[tokio::test]
async fn current_events_disposition_groups_observable() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus::load_named(VERSION, "event-dispositions");
    let (fake, gate) = fake_daemon::spawn_strict_gated(scenario, "event-dispositions".into()).await;
    let fake = Arc::new(fake);
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("warm session");

    let calls_before = fake.recorded_calls();

    // 1. heartbeat: intentional no-op — nothing emitted, nothing fetched.
    gate.push(sse_frame(
        1,
        json!({"type": "heartbeat", "timestamp": "1970-01-01T00:00:00.000Z"}),
    ))
    .await
    .expect("push heartbeat");
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        fake.recorded_calls(),
        calls_before,
        "heartbeat must not trigger any fetch"
    );
    let quiescent = drain_until(
        &mut rx,
        tokio::time::Instant::now() + Duration::from_millis(150),
        |_| true,
    )
    .await;
    assert!(
        quiescent.is_empty(),
        "heartbeat must not emit any driver event: {quiescent:?}"
    );

    // 2. message_start → SessionUpdated (Running).
    gate.push(sse_frame(
        2,
        json!({"type": "message_start", "prompt_id": "PROMPT_0"}),
    ))
    .await
    .expect("push message_start");
    let mapped = drain_until(
        &mut rx,
        tokio::time::Instant::now() + Duration::from_secs(3),
        |ev| {
            matches!(ev, SessionDriverEvent::SessionUpdated { snapshot, .. }
                if snapshot.status == SessionStatus::Running)
        },
    )
    .await;
    assert_eq!(
        mapped.len(),
        1,
        "message_start must map to one SessionUpdated"
    );

    // 3. session_state_changed → GET /state recorded.
    gate.push(sse_frame(
        3,
        json!({"type": "session_state_changed", "domains": ["todos"]}),
    ))
    .await
    .expect("push session_state_changed");
    let state_calls_before = fake
        .recorded_calls()
        .iter()
        .filter(|(m, p)| m == "GET" && p == "/state")
        .count();
    wait_for(
        &fake,
        tokio::time::Instant::now() + Duration::from_secs(5),
        move |f| {
            f.recorded_calls()
                .iter()
                .filter(|(m, p)| m == "GET" && p == "/state")
                .count()
                > state_calls_before
        },
    )
    .await;

    // 4. model_error → warning Notify with the daemon's message ("E500: internal provider failure").
    gate.push(sse_frame(
        4,
        json!({
            "type": "model_error",
            "prompt_id": "PROMPT_0",
            "error": {"type": "other", "code": "E500", "message": "internal provider failure"}
        }),
    ))
    .await
    .expect("push model_error");
    let notices = wait_for_event(
        &mut rx,
        tokio::time::Instant::now() + Duration::from_secs(3),
        |ev| {
            matches!(ev, SessionDriverEvent::HostUiRequest {
                request: HostUiRequest::Notify { message, level, .. }, ..
            } if message.contains("E500: internal provider failure")
                && *level == Some(NotifyLevel::Warning))
        },
    )
    .await;
    assert!(
        !notices.is_empty(),
        "model_error must surface a warning Notify with the daemon message"
    );

    // 5. stream_discontinuity → reseed fetches (GET /state then GET /history).
    gate.push(sse_frame(
        5,
        json!({"type": "stream_discontinuity", "missed": 3}),
    ))
    .await
    .expect("push stream_discontinuity");
    let reseed_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let resets = wait_for_event(&mut rx, reseed_deadline, |ev| {
        matches!(ev, SessionDriverEvent::SessionReset { .. })
    })
    .await;
    // wait_for_event returns on the first match, so this is a presence check;
    // the exact reseed COUNT is enforced by strict expectation consumption
    // (an extra reseed would issue undeclared fetches and 500).
    assert!(
        !resets.is_empty(),
        "stream_discontinuity must reseed; calls: {:?}",
        fake.recorded_calls()
    );

    let calls = fake.recorded_calls();
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/state")
            .count(),
        3,
        "attach + state-change refetch + reseed: {calls:?}"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p)| m == "GET" && p == "/history")
            .count(),
        2,
        "seed + reseed: {calls:?}"
    );
    // Strict consumption proves the call sequence matches the declared http[]
    // exactly — no extra or missing calls anywhere in the flow.
    fake.assert_expectations_consumed()
        .expect("event-dispositions contract consumed");
}

// ---------------------------------------------------------------------------
// 10. Command/action errors preserve the daemon's public code/message (AC.11)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum ActionErrorKind {
    GoalSet500,
    Compact409,
    SetTitle500,
    Prompt500,
    Abort500,
}

impl ActionErrorKind {
    fn http(&self) -> Vec<HttpEntry> {
        let mut http = attach_http(vec![]);
        match self {
            ActionErrorKind::GoalSet500 => http.push(http_entry_with_body(
                "POST",
                "/goal",
                json!({"summary": "finish the thing"}),
                500,
                json!({"code": "goal_boom", "message": "goal endpoint exploded"}),
            )),
            ActionErrorKind::Compact409 => http.push(http_entry_with_body(
                "POST",
                "/compact",
                Value::Null,
                409,
                json!({"code": "compaction_denied", "message": "a compaction is already running"}),
            )),
            ActionErrorKind::SetTitle500 => http.push(http_entry_with_body(
                "POST",
                "/title",
                json!({"title": "my title"}),
                500,
                json!({"code": "title_rejected", "message": "title invalid"}),
            )),
            ActionErrorKind::Prompt500 => http.push(http_entry_with_body(
                "POST",
                "/prompt",
                json!({"content": "hello"}),
                500,
                json!({"code": "prompt_rejected", "message": "prompt denied"}),
            )),
            ActionErrorKind::Abort500 => http.push(http_entry_with_body(
                "POST",
                "/turn/cancel",
                Value::Null,
                500,
                json!({"code": "cancel_failed", "message": "could not cancel"}),
            )),
        }
        http
    }

    fn session_id(&self) -> String {
        format!("action-error-{:?}", self).to_lowercase()
    }

    /// The daemon's public code + message the test must see preserved.
    fn public_error(&self) -> (&'static str, &'static str) {
        match self {
            ActionErrorKind::GoalSet500 => ("goal_boom", "goal endpoint exploded"),
            ActionErrorKind::Compact409 => ("compaction_denied", "a compaction is already running"),
            ActionErrorKind::SetTitle500 => ("title_rejected", "title invalid"),
            ActionErrorKind::Prompt500 => ("prompt_rejected", "prompt denied"),
            ActionErrorKind::Abort500 => ("cancel_failed", "could not cancel"),
        }
    }
}

/// Every command/action error must preserve the daemon's public code/message
/// in the caller-visible error AND (for the notice-emitting session actions)
/// in the warning Notify the driver emits.
#[tokio::test]
async fn command_action_error_propagation_preserves_daemon_error() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    for kind in [
        ActionErrorKind::GoalSet500,
        ActionErrorKind::Compact409,
        ActionErrorKind::SetTitle500,
        ActionErrorKind::Prompt500,
        ActionErrorKind::Abort500,
    ] {
        let (code, message) = kind.public_error();
        let scenario = synthetic_scenario(
            &format!("action-error-{:?}", kind).to_lowercase(),
            kind.http(),
        );
        let session_id = kind.session_id();
        let fake = Arc::new(
            fake_daemon::spawn_strict_with_bootstrap(scenario, session_id.clone(), 0).await,
        );
        let _ovr = OverrideGuard::install(fake.clone());
        let (driver, _dir) = make_driver().await;
        let (_sub_id, mut rx) = collect_events(&driver, 256);
        driver
            .new_session(NewSessionOptsData::default())
            .await
            .expect("warm session");

        let error = match &kind {
            ActionErrorKind::GoalSet500 => driver
                .session_action(
                    SessionAction::GoalSet {
                        summary: "finish the thing".into(),
                    },
                    Some(session_id.clone()),
                )
                .await
                .expect_err("goal 500 must fail"),
            ActionErrorKind::Compact409 => driver
                .session_action(SessionAction::Compact, Some(session_id.clone()))
                .await
                .expect_err("compact 409 must fail"),
            ActionErrorKind::SetTitle500 => driver
                .session_action(
                    SessionAction::SetTitle {
                        title: "my title".into(),
                    },
                    Some(session_id.clone()),
                )
                .await
                .expect_err("title 500 must fail"),
            ActionErrorKind::Prompt500 => driver
                .prompt("hello".into(), None, Some(session_id.clone()), vec![], None)
                .await
                .expect_err("prompt 500 must fail"),
            ActionErrorKind::Abort500 => driver
                .abort(Some(session_id.clone()))
                .await
                .expect_err("cancel 500 must fail"),
        };

        // The caller-visible error preserves the daemon's code + message.
        assert!(error.contains(message), "{kind:?}: {error}");
        assert!(error.contains(code), "{kind:?}: {error}");

        // session_action failures ALSO surface a warning Notify carrying the
        // same daemon error (prompt/abort propagate to the caller only).
        if matches!(
            kind,
            ActionErrorKind::GoalSet500
                | ActionErrorKind::Compact409
                | ActionErrorKind::SetTitle500
        ) {
            let notices = wait_for_event(
                &mut rx,
                tokio::time::Instant::now() + Duration::from_secs(3),
                |ev| {
                    matches!(ev, SessionDriverEvent::HostUiRequest {
                        request: HostUiRequest::Notify { message: notice_message, level, .. }, ..
                    } if notice_message.contains(message) && notice_message.contains(code)
                        && *level == Some(NotifyLevel::Warning))
                },
            )
            .await;
            assert!(
                !notices.is_empty(),
                "{kind:?}: the warning Notify must carry the daemon error"
            );
        }
        fake.assert_expectations_consumed()
            .expect("action-error contract consumed");
    }
}

// ---------------------------------------------------------------------------
// 4. Mid-turn usage polling + context-meter percent clamp (`get_usage`)
//
// Port of the TS-era usage poll (`polytoken-driver.ts:1318-1350`,
// `USAGE_POLL_MS = 3000`): the sync return stays the CACHED usage and, while a
// turn is in flight, at most one throttled, single-flight `GET /state` refresh
// keeps `last_state` (and thus the context meter) climbing mid-turn. These
// tests use the STRICT GATED fake (stream held open, no reconnect, no
// synthetic discontinuity → no reseed traffic) so the only `/state` calls are
// the hydration fetch + the declared polls, in a deterministic global order.
// ---------------------------------------------------------------------------

/// A `/state` body carrying `turn_in_flight` + a `context_usage` snapshot —
/// the two fields the usage-poll/clamp contract needs beyond the minimal
/// `state_body` shape.
fn state_body_with_usage(
    title: &str,
    used_tokens: i64,
    limit_tokens: i64,
    turn_in_flight: bool,
) -> Value {
    json!({
        "session_title": title, "todos": [], "flags": [], "env": {},
        "active_facet": "execute", "plugin_config": {}, "project_cwd": "/PROJECT",
        "turn_in_flight": turn_in_flight,
        "context_usage": {"used_tokens": used_tokens, "limit_tokens": limit_tokens}
    })
}

fn count_state_calls(fake: &fake_daemon::FakeDaemon) -> usize {
    fake.recorded_calls()
        .iter()
        .filter(|(m, p)| m == "GET" && p == "/state")
        .count()
}

/// Warm a session against a strict gated fake; returns the driver's session id.
async fn warm_strict_session(
    driver: &PolytokenDriver,
    fake: &Arc<fake_daemon::FakeDaemon>,
) -> String {
    driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("warm path must succeed");
    fake.session_id.clone()
}

#[tokio::test]
async fn get_usage_returns_cached_usage_for_warm_session() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    // Hydration /state carries usage over the window (300k / 200k = 150%) with
    // a turn in flight. No poll fires: the `USAGE_POLL_MS` throttle window
    // starts at warm and this test reads the cache immediately.
    let scenario = synthetic_scenario(
        "usage-warm",
        vec![
            http_entry(
                "GET",
                "/state",
                200,
                state_body_with_usage("main", 300_000, 200_000, true),
            ),
            http_entry("GET", "/history", 200, history_body(vec![], 0)),
        ],
    );
    let (fake, _gate) = fake_daemon::spawn_strict_gated(scenario, "usage-warm".into()).await;
    let fake = Arc::new(fake);
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;
    let sid = warm_strict_session(&driver, &fake).await;

    let usage = driver
        .get_usage(Some(sid.clone()))
        .expect("warm session has cached usage");
    // Percent clamped at 100 (the raw ratio is 150%); tokens/window stay raw so
    // the popup's "tokens / window tokens" line remains the truth.
    assert_eq!(usage.percent, Some(100.0));
    assert_eq!(usage.tokens, Some(300_000));
    assert_eq!(usage.context_window, 200_000);

    // Unknown / cold / absent sessions yield None.
    assert!(driver.get_usage(Some("unknown".into())).is_none());
    assert!(driver.get_usage(None).is_none());

    // No poll fired inside the throttle window: exactly the hydration fetch.
    assert_eq!(count_state_calls(&fake), 1);
    fake.assert_expectations_consumed()
        .expect("usage-warm contract consumed");
}

#[tokio::test]
async fn mid_turn_usage_poll_is_throttled_and_single_flight() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    // Hydration /state + seed /history, then ONE declared poll /state. The
    // throttle (one fetch per 3s) + single-flight gates allow exactly one extra
    // fetch; a second would be an undeclared request and fail the strict fake
    // loudly (and leave an unconsumed expectation on drop).
    let scenario = synthetic_scenario(
        "usage-throttle",
        vec![
            http_entry(
                "GET",
                "/state",
                200,
                state_body_with_usage("main", 100_000, 200_000, true),
            ),
            http_entry("GET", "/history", 200, history_body(vec![], 0)),
            http_entry(
                "GET",
                "/state",
                200,
                state_body_with_usage("main", 120_000, 200_000, true),
            ),
        ],
    );
    let (fake, _gate) = fake_daemon::spawn_strict_gated(scenario, "usage-throttle".into()).await;
    let fake = Arc::new(fake);
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;
    let sid = warm_strict_session(&driver, &fake).await;

    let baseline = count_state_calls(&fake);
    assert_eq!(baseline, 1, "hydration fetch only");

    // Bounded retry: keep firing get_usage until the poll lands (the 3s
    // throttle window opens inside this loop; only ONE call can pass the
    // gates). Synchronizes against the detached tokio::spawn poll via the fake
    // daemon's /state call log — no fixed sleeps.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    while count_state_calls(&fake) < baseline + 1 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "usage poll never fired; calls: {:?}",
            fake.recorded_calls()
        );
        let _ = driver.get_usage(Some(sid.clone()));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // A back-to-back call immediately after the poll was kicked: suppressed by
    // the in-flight gate (and/or the 3s throttle). Exactly one extra fetch.
    let _ = driver.get_usage(Some(sid.clone()));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        count_state_calls(&fake),
        baseline + 1,
        "the second get_usage must be suppressed by the throttle + single-flight gates"
    );
    fake.assert_expectations_consumed()
        .expect("usage-throttle contract consumed");
}

#[tokio::test]
async fn usage_poll_refreshes_cached_state() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    // Hydration serves usage X (100k / 200k = 50%); the polls' /state serves
    // the CHANGED usage Y (160k / 200k = 80%) — strict order declares both.
    let scenario = synthetic_scenario(
        "usage-refresh",
        vec![
            http_entry(
                "GET",
                "/state",
                200,
                state_body_with_usage("main", 100_000, 200_000, true),
            ),
            http_entry("GET", "/history", 200, history_body(vec![], 0)),
            http_entry(
                "GET",
                "/state",
                200,
                state_body_with_usage("main", 160_000, 200_000, true),
            ),
            http_entry(
                "GET",
                "/state",
                200,
                state_body_with_usage("main", 160_000, 200_000, true),
            ),
        ],
    );
    let (fake, _gate) = fake_daemon::spawn_strict_gated(scenario, "usage-refresh".into()).await;
    let fake = Arc::new(fake);
    let _ovr = OverrideGuard::install(fake.clone());
    let (driver, _dir) = make_driver().await;
    let sid = warm_strict_session(&driver, &fake).await;
    let baseline = count_state_calls(&fake);
    assert_eq!(baseline, 1);

    // Pre-poll: the sync return is the CACHED usage X (no fetch — the throttle
    // window hasn't opened).
    let cached = driver.get_usage(Some(sid.clone())).expect("cached usage");
    assert_eq!(cached.tokens, Some(100_000));
    assert_eq!(cached.percent, Some(50.0));

    // Bounded retry until the poll lands and refreshes last_state to Y (the
    // sync return is the cached value until the refresh completes).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    let mut refreshed: Option<SessionUsage> = None;
    while !matches!(refreshed, Some(ref u) if u.tokens == Some(160_000)) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "usage never refreshed; calls: {:?}",
            fake.recorded_calls()
        );
        refreshed = driver.get_usage(Some(sid.clone()));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let usage = refreshed.expect("refreshed usage");
    assert_eq!(usage.tokens, Some(160_000));
    assert_eq!(usage.context_window, 200_000);
    assert_eq!(usage.percent, Some(80.0));

    // The single-flight gate released: once the 3s throttle window reopens, a
    // SECOND poll can fire (if the in-flight flag never cleared, no second
    // fetch would ever happen). Serves the same Y recording.
    let deadline2 = tokio::time::Instant::now() + Duration::from_secs(10);
    while count_state_calls(&fake) < baseline + 2 {
        assert!(
            tokio::time::Instant::now() < deadline2,
            "usage-poll gate never released; calls: {:?}",
            fake.recorded_calls()
        );
        let _ = driver.get_usage(Some(sid.clone()));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Still exactly one fetch per throttle window.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(count_state_calls(&fake), baseline + 2);
    fake.assert_expectations_consumed()
        .expect("usage-refresh contract consumed");
}
