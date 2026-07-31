//! An in-process fake polytoken daemon, driven by the frozen corpus.
//!
//! Replays a `ScenarioFile` over a real ephemeral axum port speaking the same
//! wire protocol as the real daemon: HTTP endpoints return recorded responses,
//! and `GET /events` streams the scenario's SSE frames as `text/event-stream`.
//! The spawn-override seam (`daemon_client::set_spawn_override`) points
//! `PolytokenDriver` at this port instead of launching a process, so the live
//! driver stack (`warm_session` → `DaemonClient` → `event_map`) runs end-to-end
//! against deterministic fixtures.
//!
//! Historical corpus replay uses per-endpoint cursors plus a small explicit
//! lifecycle bootstrap allowlist. Independently authored contracts opt into
//! global order/body/count matching with [`spawn_strict`]; live-driver action
//! contracts use [`spawn_strict_with_bootstrap`] to combine that strict action
//! sequence with only the tested lifecycle allowlist. Strict fakes reject every
//! other undeclared request and enforce expectation consumption on drop.
//!
//! `recorded_calls()` exposes every `(method, path)` the driver made, so tests
//! can assert e.g. `GET /state` / `GET /turn/input` fired after an effect.
//
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use axum::{
    Router,
    extract::{Query, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, Sse},
    },
    routing::{any, get},
};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::polytoken::corpus::{self, ScenarioFile};
use crate::polytoken::daemon_client::{
    SpawnDaemonOpts, SpawnedDaemon, clear_spawn_override, set_spawn_override,
};

/// Per-frame delay between SSE frames pushed by `FakeControlHub::run_script`
/// (controlled mode). Widens the window in which mid-flow UI (the queue tray,
/// a working indicator) is observable by the dev surface + e2e assertions. See
/// the push loop for rationale.
const CONTROLLED_INTER_FRAME_DELAY_MS: u64 = 8;

/// One canned response for the tiny bootstrap allowlist. This is deliberately
/// consulted only when the active scenario declares no request with this
/// method/path; a declared endpoint can never silently fall through to canned.
fn canned(method: &str, path: &str) -> Option<(StatusCode, Value)> {
    let (m, p) = (method, path);
    // GET /health — minimal healthy body. `HealthResponse` requires several
    // fields; we supply a valid-shaped record so `health()` returns status 200
    // with parseable data.
    if m == "GET" && p == "/health" {
        return Some((
            StatusCode::OK,
            serde_json::json!({
                "last_heartbeat_at": "1970-01-01T00:00:00.000Z",
                "parent_session_id": {"workspace_id": "ws", "session_id": "SESSION"},
                "pid": 1,
                "port": 0,
                "project_path": "/PROJECT",
                "session_id": "SESSION",
                "started_at": "1970-01-01T00:00:00.000Z",
            }),
        ));
    }
    // POST /tui-attachment/claim — `TuiAttachClaimResponse`.
    if m == "POST" && p == "/tui-attachment/claim" {
        return Some((
            StatusCode::OK,
            serde_json::json!({
                "expires_after_seconds": 300,
                "expires_at": "1970-01-01T00:05:00.000Z",
                "heartbeat_interval_seconds": 5,
                "lease_id": "lease-1",
            }),
        ));
    }
    // POST /tui-attachment/heartbeat — ack.
    if m == "POST" && p == "/tui-attachment/heartbeat" {
        return Some((StatusCode::OK, serde_json::json!({"ok": true})));
    }
    // POST /tui-attachment/release + /terminate — best-effort cleanup acks.
    if m == "POST" && (p == "/tui-attachment/release" || p == "/terminate") {
        return Some((StatusCode::OK, serde_json::json!({"ok": true})));
    }
    // DELETE /tui-attachment/{lease_id} — `release_lease()` uses this (not POST
    // /tui-attachment/release). The lease_id is one nonempty path segment.
    // Idempotent → 204 No Content (empty body).
    if m == "DELETE"
        && p.strip_prefix("/tui-attachment/")
            .is_some_and(|lease_id| !lease_id.is_empty() && !lease_id.contains(['/', '?', '#']))
    {
        return Some((StatusCode::NO_CONTENT, Value::Null));
    }
    // POST /model — acknowledge model/thinking switches. Tests inspect the
    // recorded body to verify the driver sent the daemon's full registry key.
    if m == "POST" && p == "/model" {
        return Some((StatusCode::OK, serde_json::json!({"ok": true})));
    }
    // POST /title — acknowledge an operator title override (a rename). Tests
    // inspect the recorded request body to verify the submitted title.
    if m == "POST" && p == "/title" {
        return Some((
            StatusCode::OK,
            serde_json::json!({"title": "", "overridden": true}),
        ));
    }
    // Required attach snapshots not represented by the older scenario corpus.
    if m == "GET" && p == "/permission-monitor" {
        return Some((
            StatusCode::OK,
            serde_json::json!({
                "monitor": {"type": "bypass_plus"},
                "config_default": {"type": "bypass_plus"},
                "configured_autonomous": null
            }),
        ));
    }
    if m == "GET" && p == "/notification-autodrain" {
        return Some((
            StatusCode::OK,
            serde_json::json!({"enabled": true, "config_default": true}),
        ));
    }
    // GET /turn/input — the RefetchQueue effect's snapshot fetch. The corpus
    // doesn't record /turn/input (the queue-while-in-flight scenario triggers
    // a RefetchQueue but the capture didn't snapshot it), so serve a canned
    // PendingTurnInputSnapshot with one queued item so the driver can build a
    // QueueUpdated. (Tests that assert on the real queue contents use a
    // synthetic scenario instead.)
    if m == "GET" && p == "/turn/input" {
        return Some((
            StatusCode::OK,
            serde_json::json!({
                "items": [
                    {"id": "q1", "content": "queued-turn-text", "admission_prompt_id": "PROMPT_0"}
                ],
                "queue_revision": 2
            }),
        ));
    }
    // DELETE /turn/input/newest — clear_queue's drain primitive. Tests count the
    // recorded calls (one per snapshotted item) to verify the full drain.
    if m == "DELETE" && p == "/turn/input/newest" {
        return Some((StatusCode::OK, serde_json::json!({"ok": true})));
    }
    None
}

/// Match one request against the next declared scenario expectation. The cursor
/// is intentionally global: strict HTTP recordings describe one ordered
/// conversation, not independent endpoint fixtures.
fn match_http_expectation(
    scenario: &ScenarioFile,
    next: usize,
    method: &str,
    path: &str,
    request_body: &str,
) -> Result<Option<corpus::HttpEntry>, String> {
    let declared_pair = scenario
        .http
        .iter()
        .any(|entry| entry.method == method && entry.path == path);
    if !declared_pair {
        return Ok(None);
    }
    let Some(expected) = scenario.http.get(next) else {
        return Err(format!("unexpected extra request: {method} {path}"));
    };
    if expected.method != method || expected.path != path {
        return Err(format!(
            "request order mismatch at expectation {next}: expected {} {}, got {method} {path}",
            expected.method, expected.path
        ));
    }
    let actual_body = if request_body.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str::<Value>(request_body)
            .map_err(|e| format!("invalid JSON request body for {method} {path}: {e}"))?
    };
    let expected_body = expected.request_body.clone().unwrap_or(Value::Null);
    if actual_body != expected_body {
        return Err(format!(
            "request body mismatch for {method} {path}: expected {}, got {}",
            expected_body, actual_body
        ));
    }
    Ok(Some(expected.clone()))
}

/// The mutable harness state: the recorded-call log + the global HTTP cursor.
#[derive(Default)]
struct FakeState {
    /// Every `(METHOD, path)` the driver called, in arrival order.
    calls: Vec<(String, String)>,
    /// Every `(METHOD, path, body)` the driver called, in arrival order.
    request_bodies: Vec<(String, String, String)>,
    /// Per `(METHOD, path)` replay cursors used by historical loose scenarios.
    cursors: HashMap<(String, String), usize>,
    /// Index of the next declared HTTP expectation in strict mode.
    next_http_expectation: usize,
    /// Number of expectations in the currently armed scenario.
    declared_http_expectations: usize,
    /// Strict mode is opt-in for independently authored contract scenarios.
    strict: bool,
    /// A distinct integration mode permits only the tiny lifecycle bootstrap
    /// allowlist around an otherwise strict authored scenario.
    allow_bootstrap: bool,
    /// Controlled-mode SSE sender. Present after GET /events connects; reset
    /// replaces it so a reset mid-stream cannot corrupt a later producer.
    sse_tx: Option<mpsc::Sender<Result<Event, std::convert::Infallible>>>,
    /// The active HTTP-replay scenario. In controlled (fake-mode) use this
    /// starts as the idle bootstrap scenario, then `run_script` swaps in the
    /// chosen flow's recordings (and resets cursors) so that flow's in-turn
    /// `FetchState`/`RefetchQueue` calls serve its own recorded responses
    /// (post-turn usage/title, the queue snapshot, etc.) rather than the
    /// bootstrap's idle body. `None` on the one-shot `spawn` path, which keeps
    /// reading the spawn-time `AppState.scenario`.
    scenario_override: Option<Arc<ScenarioFile>>,
}

/// The public handle returned by `spawn`. Owns the running server task + the
/// shared recorded-call log.
pub struct FakeDaemon {
    pub port: u16,
    pub session_id: String,
    state: Arc<Mutex<FakeState>>,
    /// Abort the server task on drop so the ephemeral port is released.
    _serve: tokio::task::JoinHandle<()>,
}

impl FakeDaemon {
    /// Every `(method, path)` the driver has made so far, in arrival order.
    pub fn recorded_calls(&self) -> Vec<(String, String)> {
        self.state.lock().calls.clone()
    }

    /// Every `(method, path, body)` the driver has made so far, in arrival order.
    pub fn recorded_request_bodies(&self) -> Vec<(String, String, String)> {
        self.state.lock().request_bodies.clone()
    }

    /// Fail the test/harness if any required scenario HTTP expectation remains.
    pub fn assert_expectations_consumed(&self) -> Result<(), String> {
        let st = self.state.lock();
        if !st.strict {
            return Err("expectation consumption is available only for spawn_strict fakes".into());
        }
        if st.next_http_expectation != st.declared_http_expectations {
            return Err(format!(
                "fake daemon has {} unconsumed HTTP expectation(s), starting at index {}",
                st.declared_http_expectations
                    .saturating_sub(st.next_http_expectation),
                st.next_http_expectation
            ));
        }
        Ok(())
    }

    /// Assert consumption against an explicitly selected scenario. This keeps
    /// the check useful after controlled reset/arm without exposing mutable state.
    pub fn assert_expectations_consumed_for_scenario(
        &self,
        scenario: &ScenarioFile,
    ) -> Result<(), String> {
        let st = self.state.lock();
        if !st.strict {
            return Err("expectation consumption is available only for spawn_strict fakes".into());
        }
        if st.next_http_expectation != scenario.http.len() {
            return Err(format!(
                "fake daemon has {} unconsumed HTTP expectation(s), starting at index {}",
                scenario.http.len().saturating_sub(st.next_http_expectation),
                st.next_http_expectation
            ));
        }
        Ok(())
    }

    /// True iff the driver made a call matching `method` + `path`.
    pub fn called(&self, method: &str, path: &str) -> bool {
        self.state
            .lock()
            .calls
            .iter()
            .any(|(m, p)| m == method && p == path)
    }

    /// Swap the HTTP-replay scenario to `scenario` and reset the replay
    /// cursors + call log, so the chosen flow's in-turn HTTP fetches
    /// (`FetchState`→`/state`, `RefetchQueue`→`/turn/input`, a `Reseed`→
    /// `/history`) serve that flow's recorded responses. Used by
    /// `FakeControlHub::run_script` to arm a flow before pushing its SSE
    /// frames. Controlled-mode only (one-shot `spawn` does not swap).
    fn arm_scenario(&self, scenario: Arc<ScenarioFile>) {
        let mut st = self.state.lock();
        st.declared_http_expectations = scenario.http.len();
        st.strict = false;
        st.scenario_override = Some(scenario);
        st.next_http_expectation = 0;
        st.calls.clear();
    }
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        self._serve.abort();
        if std::thread::panicking() {
            return;
        }
        let state = self.state.lock();
        if state.strict && state.next_http_expectation != state.declared_http_expectations {
            panic!(
                "strict fake daemon dropped with {} unconsumed HTTP expectation(s), starting at index {}",
                state
                    .declared_http_expectations
                    .saturating_sub(state.next_http_expectation),
                state.next_http_expectation
            );
        }
    }
}

/// Query params captured for path matching (the corpus paths are query-free, so
/// we match on the path component only). Kept for future richer matching.
#[derive(Debug, serde::Deserialize)]
struct QueryParams {
    #[serde(default)]
    #[allow(dead_code)]
    rest: HashMap<String, String>,
}

#[derive(Clone)]
pub struct HydrationRaceControl {
    state_requested: Arc<tokio::sync::Semaphore>,
    event_sent: Arc<tokio::sync::Semaphore>,
    release_state: Arc<tokio::sync::Semaphore>,
    stream_closed: Arc<tokio::sync::Semaphore>,
}

impl HydrationRaceControl {
    async fn wait(semaphore: &tokio::sync::Semaphore) {
        semaphore
            .acquire()
            .await
            .expect("hydration race semaphore remains open")
            .forget();
    }
    pub async fn wait_state_requested(&self) {
        Self::wait(&self.state_requested).await;
    }

    pub async fn wait_event_sent(&self) {
        Self::wait(&self.event_sent).await;
    }

    pub fn release_state(&self) {
        self.release_state.add_permits(1);
    }

    pub async fn wait_stream_closed(&self) {
        Self::wait(&self.stream_closed).await;
    }
}

/// Push handle for [`spawn_strict_gated`]: delivers frames onto the CURRENT
/// SSE stream (the one established by the latest `GET /events`) and can end it
/// to force the client's reconnect path. The shared slot is replaced on each
/// connection, so a push after a reconnect targets the live stream.
#[derive(Clone)]
pub struct GatedSseControl {
    tx: Arc<Mutex<Option<mpsc::Sender<Result<Event, std::convert::Infallible>>>>>,
}

impl GatedSseControl {
    /// Push one SSE frame onto the connected stream. Fails if no stream is
    /// currently connected or the client has dropped the receiver.
    pub async fn push(&self, frame: corpus::SseFrame) -> Result<(), String> {
        let tx = self
            .tx
            .lock()
            .clone()
            .ok_or("fake gated SSE stream not connected")?;
        tx.send(Ok(frame_to_event(&frame)))
            .await
            .map_err(|_| "fake gated SSE stream disconnected".into())
    }

    /// End the current SSE stream by dropping its sender. The client's SSE
    /// loop sees a normal stream end and reconnects with backoff.
    pub fn close(&self) {
        self.tx.lock().take();
    }
}

#[derive(Clone)]
enum SseMode {
    OneShot {
        inter_frame_delay_ms: u64,
    },
    Controlled,
    Gated {
        tx: Arc<Mutex<Option<mpsc::Sender<Result<Event, std::convert::Infallible>>>>>,
    },
    HydrationRace {
        frame: corpus::SseFrame,
        control: HydrationRaceControl,
    },
}

/// Spawn a fake daemon serving `scenario` on an ephemeral port.
///
/// `session_id` is what the spawn-override reports back to the driver (it
/// becomes the `PolytokenDriver`'s session id). The `inter_frame_delay_ms`
/// controls the SSE pacing — a tiny nonzero delay exercises the per-event
/// ordering invariant without slowing the common case.
pub async fn spawn(
    scenario: ScenarioFile,
    session_id: String,
    inter_frame_delay_ms: u64,
) -> FakeDaemon {
    spawn_with_mode(
        scenario,
        session_id,
        SseMode::OneShot {
            inter_frame_delay_ms,
        },
        false,
        false,
    )
    .await
}

/// Spawn a strict contract fake. Unlike historical [`spawn`], this consumes
/// `http[]` in one global order, validates request bodies/counts, and rejects
/// every request absent from the authored contract.
pub async fn spawn_strict(
    scenario: ScenarioFile,
    session_id: String,
    inter_frame_delay_ms: u64,
) -> FakeDaemon {
    spawn_with_mode(
        scenario,
        session_id,
        SseMode::OneShot {
            inter_frame_delay_ms,
        },
        true,
        false,
    )
    .await
}

/// Spawn a strict action contract wrapped by the explicit daemon lifecycle
/// bootstrap allowlist needed to warm and dispose a live driver session.
pub async fn spawn_strict_with_bootstrap(
    scenario: ScenarioFile,
    session_id: String,
    inter_frame_delay_ms: u64,
) -> FakeDaemon {
    spawn_with_mode(
        scenario,
        session_id,
        SseMode::OneShot {
            inter_frame_delay_ms,
        },
        true,
        true,
    )
    .await
}

/// Spawn a deterministic attach-race daemon. `/state` blocks until the test
/// releases it, while the selected SSE frame is sent after `/state` has entered.
pub async fn spawn_hydration_race(
    scenario: ScenarioFile,
    session_id: String,
    frame: corpus::SseFrame,
) -> (FakeDaemon, HydrationRaceControl) {
    let control = hydration_race_control();
    let fake = spawn_with_mode(
        scenario,
        session_id,
        SseMode::HydrationRace {
            frame,
            control: control.clone(),
        },
        false,
        false,
    )
    .await;
    (fake, control)
}

/// Spawn a STRICT attach-race daemon: the hydration-race `/state` gate PLUS
/// strict expectation consumption wrapped by the lifecycle bootstrap
/// allowlist. The attach chain (`GET /events`, `GET /state`, `GET /history`)
/// must be declared in the driver's real call order; `/health`,
/// `/tui-attachment/*`, `/permission-monitor`, `/notification-autodrain`
/// stay canned. This is the contract engine for the attach-race scenario:
/// the test proves `/events` connects before `/state`, the buffered
/// `message_start` is delivered exactly once after hydration, and every
/// declared expectation is consumed.
pub async fn spawn_strict_hydration_race(
    scenario: ScenarioFile,
    session_id: String,
    frame: corpus::SseFrame,
) -> (FakeDaemon, HydrationRaceControl) {
    let control = hydration_race_control();
    let fake = spawn_with_mode(
        scenario,
        session_id,
        SseMode::HydrationRace {
            frame,
            control: control.clone(),
        },
        true,
        true,
    )
    .await;
    (fake, control)
}

/// Spawn a strict gated-stream fake. The SSE stream stays open and the test
/// pushes frames through [`GatedSseControl`] AFTER the warm attach completes,
/// so effect-triggering events (`session_state_changed`, `stream_discontinuity`,
/// `context_cleared`, …) fold at a deterministic time — never racing the
/// seed-path `GET /history` that strict global ordering would otherwise make
/// flaky. `http[]` is still consumed strictly, in arrival order, and every
/// declared expectation must be consumed by test end.
pub async fn spawn_strict_gated(
    scenario: ScenarioFile,
    session_id: String,
) -> (FakeDaemon, GatedSseControl) {
    let control = GatedSseControl {
        tx: Arc::new(parking_lot::Mutex::new(None)),
    };
    let fake = spawn_with_mode(
        scenario,
        session_id,
        SseMode::Gated {
            tx: control.tx.clone(),
        },
        true,
        true,
    )
    .await;
    (fake, control)
}

fn hydration_race_control() -> HydrationRaceControl {
    HydrationRaceControl {
        state_requested: Arc::new(tokio::sync::Semaphore::new(0)),
        event_sent: Arc::new(tokio::sync::Semaphore::new(0)),
        release_state: Arc::new(tokio::sync::Semaphore::new(0)),
        stream_closed: Arc::new(tokio::sync::Semaphore::new(0)),
    }
}

async fn spawn_controlled(scenario: ScenarioFile, session_id: String) -> Arc<FakeDaemon> {
    Arc::new(spawn_with_mode(scenario, session_id, SseMode::Controlled, false, false).await)
}

/// The idle landing scenario for a fake-mode bootstrap session: an empty
/// transcript with `turn_in_flight:false`, so the seeded `sessionOpened`
/// snapshot is `Idle` and the composer renders its placeholder. No corpus
/// scenario represents this (they are all active-flow captures); this is the
/// only synthetic fixture the fake daemon needs. The SSE list is empty —
/// controlled mode holds the stream open for `run_script` to push a chosen
/// flow's frames. The version is threaded in only for the `ScenarioFile`
/// field; the body must deserialize as a full `SessionStateSnapshot`
/// (mirroring `synthetic_idle_scenario` in tests/live_path.rs).
fn bootstrap_scenario(version: &str) -> ScenarioFile {
    let json_str = serde_json::json!({
        "scenario": "bootstrap-idle",
        "version": version,
        "provenance": {"kind": "synthetic_pantoken_regression"},
        "description": "idle empty landing session for fake-mode bootstrap",
        "canonicalization": {
            "session_id": "SESSION",
            "prompt_ids": {},
            "timestamps": "monotonic-from-T0"
        },
        "http": [
            { "method": "GET", "path": "/state", "status": 200,
              "response_body": {
                  "session_title": "fake",
                  "todos": [],
                  "flags": [],
                  "env": {},
                  "project_cwd": "/fake",
                  "active_facet": "execute",
                  "plugin_config": {},
                  "turn_in_flight": false
              } },
            { "method": "GET", "path": "/history", "status": 200,
              "response_body": {
                  "items": [], "offset": 0, "total_projected_items": 0,
                  "history_revision": 0, "session_id": "SESSION"
              } }
        ],
        "sse": [],
        "expected_driver_events": {"capabilities": [], "events": [], "effects": [], "final_session": {"mapped_event_count": 0, "assistant_delta_count": 0, "open_block_count": 0, "tool_input_buffer_empty": true, "turn_error_present": false}, "required_requests": [], "forbidden_requests": []}
    })
    .to_string();
    serde_json::from_str::<ScenarioFile>(&json_str).expect("parse bootstrap scenario")
}

async fn spawn_with_mode(
    scenario: ScenarioFile,
    session_id: String,
    sse_mode: SseMode,
    strict: bool,
    allow_bootstrap: bool,
) -> FakeDaemon {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let port = listener.local_addr().expect("local_addr").port();
    let scenario = Arc::new(scenario);
    let state = Arc::new(Mutex::new(FakeState {
        declared_http_expectations: scenario.http.len(),
        strict,
        allow_bootstrap,
        ..FakeState::default()
    }));

    let app = build_router(state.clone(), scenario.clone(), sse_mode);

    let serve = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service())
            .await
            .expect("fake daemon serve");
    });

    FakeDaemon {
        port,
        session_id,
        state,
        _serve: serve,
    }
}

#[derive(Clone)]
pub struct FakeControlHub {
    inner: Arc<FakeControlInner>,
}

struct FakeControlInner {
    version: String,
    scenarios: Mutex<HashMap<String, ScenarioFile>>,
    sessions: Mutex<HashMap<String, Arc<FakeDaemon>>>,
    spawned: Mutex<Vec<Arc<FakeDaemon>>>,
}

impl FakeControlHub {
    pub fn load_default() -> Self {
        let version = corpus::active_version();
        let mut scenarios = HashMap::new();
        for file in corpus::scenario_files(&version) {
            let scenario = corpus::load_scenario(&file);
            scenarios.insert(scenario.scenario.clone(), scenario);
        }
        Self {
            inner: Arc::new(FakeControlInner {
                version,
                scenarios: Mutex::new(scenarios),
                sessions: Mutex::new(HashMap::new()),
                spawned: Mutex::new(Vec::new()),
            }),
        }
    }

    pub async fn spawn_session(&self, session_prefix: &str) -> Arc<FakeDaemon> {
        let idx = self.inner.spawned.lock().len() + 1;
        let session_id = format!("{session_prefix}-{idx}");
        // The bootstrap session is the idle landing session the hub adopts at boot
        // and after each `/debug/reset`: an empty transcript with the composer
        // interactive (turn_in_flight:false). It must NOT reuse a corpus scenario —
        // every recorded scenario is an active-flow capture (streaming/abort/etc.),
        // and `reconnect-stream-discontinuity` even reports `turn_in_flight: true`
        // in its first /state recording, which would seed a Running snapshot and
        // leave the composer stuck on "Working…" (the dev surface drives a chosen
        // flow's SSE later via run_script, over this held-open idle stream).
        let scenario = bootstrap_scenario(&self.inner.version);
        let fake = spawn_controlled(scenario, session_id.clone()).await;
        self.inner
            .sessions
            .lock()
            .insert(session_id.clone(), fake.clone());
        self.inner.spawned.lock().push(fake.clone());
        fake
    }

    pub fn reset(&self) {
        // Clear the HTTP replay cursors + call log, but KEEP the held-open SSE
        // sender: the driver keeps its warm session (and SSE subscription) across
        // a dev-surface reset, so dropping the sender here would force a reconnect
        // a follow-up `run_script` would race. The driver-side accumulator reset
        // (PolytokenDriver::reset) is what clears stale fold state.
        //
        // Also drop any `run_script`-armed scenario override: a reset re-adopts
        // the idle bootstrap session, so the post-reset reseed's `GET /state`
        // must serve the idle body (not a previous flow's post-turn recording).
        for fake in self.inner.sessions.lock().values() {
            let mut state = fake.state.lock();
            state.calls.clear();
            state.cursors.clear();
            state.next_http_expectation = 0;
            // Keep the bootstrap count: reset drops the override and re-adopts
            // the spawn-time bootstrap scenario.
            state.scenario_override = None;
        }
    }

    /// Inject a custom scenario into the control hub's scenario map, so
    /// `run_script_partial` / `run_script_remaining` / `run_script` can push
    /// its SSE frames by name. Used by tests that need a synthetic scenario
    /// (e.g. `turn_in_flight: true` in the `/state` response) that isn't in
    /// the frozen corpus.
    pub fn inject_scenario(&self, scenario: ScenarioFile) {
        self.inner
            .scenarios
            .lock()
            .insert(scenario.scenario.clone(), scenario);
    }

    pub async fn run_script(&self, name: &str) -> Result<(), String> {
        let scenario_name = match name {
            "stream" | "reply" | "streaming-turn" => "streaming-turn",
            "queue" | "queue-while-in-flight" => "queue-while-in-flight",
            "abort" => "abort",
            "ask" | "ask-user-question" => "ask-user-question",
            "approve" | "tool" | "tool-call-approval" => "tool-call-approval",
            other => return Err(format!("unknown fake script: {other}")),
        };
        let scenario = self
            .inner
            .scenarios
            .lock()
            .get(scenario_name)
            .ok_or_else(|| format!("fake scenario missing: {scenario_name}"))?
            .clone();
        let fake = self
            .inner
            .spawned
            .lock()
            .last()
            .cloned()
            .ok_or_else(|| "no fake session spawned".to_string())?;
        // Arm this flow's HTTP recordings before pushing its SSE frames, so the
        // in-turn `FetchState`/`RefetchQueue`/`Reseed` effects the frames will
        // trigger serve the flow's own recorded responses (post-turn usage, the
        // queue snapshot, etc.) — not the bootstrap's idle body. Without this
        // the second `GET /state` (on `message_complete`) would 500 on cursor
        // exhaustion against the single-recording bootstrap scenario.
        fake.arm_scenario(Arc::new(scenario.clone()));
        // The driver's SSE subscription connects asynchronously, so a script
        // pushed right after boot/reset can arrive before `GET /events` has
        // registered its held-open sender. Poll briefly (up to ~2s) rather than
        // failing the push on that race.
        let tx = {
            let mut tx = None;
            for _ in 0..100 {
                if let Some(sender) = fake.state.lock().sse_tx.clone() {
                    tx = Some(sender);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            tx.ok_or_else(|| "fake SSE stream not connected".to_string())?
        };
        for frame in scenario.sse {
            tx.send(Ok(frame_to_event(&frame)))
                .await
                .map_err(|_| "fake SSE stream disconnected".to_string())?;
            // Pace the controlled push so intermediate states are observable:
            // the corpus flows are live captures that run to completion, and a
            // back-to-back push makes transient UI (e.g. the queue tray,
            // populated mid-flight then drained before the turn ends) appear
            // and vanish within a sub-millisecond window the client never
            // renders. A small inter-frame delay widens that window so the
            // dev surface (and a bounded `expect.poll` assertion) can observe
            // mid-flow DOM, and it exercises the live SSE fold path at a
            // realistic cadence rather than a zero-delay burst.
            tokio::time::sleep(std::time::Duration::from_millis(
                CONTROLLED_INTER_FRAME_DELAY_MS,
            ))
            .await;
        }
        Ok(())
    }

    /// Push the first `count` SSE frames of the named scenario, leaving the
    /// rest for a follow-up `run_script_remaining` call. Used by the AC.9
    /// mid-turn-drop test: push some frames (turn enters in-flight), drop the
    /// client, then push the rest (turn completes while the driver's SSE
    /// subscription is still alive).
    ///
    /// Arms the scenario's HTTP recordings (same as `run_script`) so in-turn
    /// fetches serve the flow's own responses.
    pub async fn run_script_partial(&self, name: &str, count: usize) -> Result<(), String> {
        let scenario_name = match name {
            "stream" | "reply" | "streaming-turn" => "streaming-turn",
            "queue" | "queue-while-in-flight" => "queue-while-in-flight",
            "abort" => "abort",
            "ask" | "ask-user-question" => "ask-user-question",
            "approve" | "tool" | "tool-call-approval" => "tool-call-approval",
            other => other, // allow injected custom scenarios by name
        };
        let scenario = self
            .inner
            .scenarios
            .lock()
            .get(scenario_name)
            .ok_or_else(|| format!("fake scenario missing: {scenario_name}"))?
            .clone();
        let fake = self
            .inner
            .spawned
            .lock()
            .last()
            .cloned()
            .ok_or_else(|| "no fake session spawned".to_string())?;
        fake.arm_scenario(Arc::new(scenario.clone()));
        let tx = {
            let mut tx = None;
            for _ in 0..100 {
                if let Some(sender) = fake.state.lock().sse_tx.clone() {
                    tx = Some(sender);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            tx.ok_or_else(|| "fake SSE stream not connected".to_string())?
        };
        let frames = &scenario.sse;
        let end = count.min(frames.len());
        for frame in &frames[..end] {
            tx.send(Ok(frame_to_event(frame)))
                .await
                .map_err(|_| "fake SSE stream disconnected".to_string())?;
            tokio::time::sleep(std::time::Duration::from_millis(
                CONTROLLED_INTER_FRAME_DELAY_MS,
            ))
            .await;
        }
        Ok(())
    }

    /// Push the remaining SSE frames of a scenario after a `run_script_partial`
    /// call. Pushes frames from index `count` onward (where `count` was the
    /// number passed to `run_script_partial`).
    pub async fn run_script_remaining(&self, name: &str, from_index: usize) -> Result<(), String> {
        let scenario_name = match name {
            "stream" | "reply" | "streaming-turn" => "streaming-turn",
            "queue" | "queue-while-in-flight" => "queue-while-in-flight",
            "abort" => "abort",
            "ask" | "ask-user-question" => "ask-user-question",
            "approve" | "tool" | "tool-call-approval" => "tool-call-approval",
            other => other, // allow injected custom scenarios by name
        };
        let scenario = self
            .inner
            .scenarios
            .lock()
            .get(scenario_name)
            .ok_or_else(|| format!("fake scenario missing: {scenario_name}"))?
            .clone();
        let fake = self
            .inner
            .spawned
            .lock()
            .last()
            .cloned()
            .ok_or_else(|| "no fake session spawned".to_string())?;
        // The scenario was already armed by run_script_partial; don't re-arm
        // (that would reset cursors + clear the call log mid-turn).
        let tx = fake
            .state
            .lock()
            .sse_tx
            .clone()
            .ok_or_else(|| "fake SSE stream not connected".to_string())?;
        let frames = &scenario.sse;
        for frame in &frames[from_index..] {
            tx.send(Ok(frame_to_event(frame)))
                .await
                .map_err(|_| "fake SSE stream disconnected".to_string())?;
            tokio::time::sleep(std::time::Duration::from_millis(
                CONTROLLED_INTER_FRAME_DELAY_MS,
            ))
            .await;
        }
        Ok(())
    }
}

pub fn install_fake_spawn(control: FakeControlHub) {
    set_spawn_override(Arc::new(move |_bin: &str, _opts: SpawnDaemonOpts| {
        let control = control.clone();
        Box::pin(async move {
            let fake = control.spawn_session("fake").await;
            Ok((
                SpawnedDaemon {
                    session_id: fake.session_id.clone(),
                    port: fake.port,
                    auth_token: None,
                },
                None,
            ))
        })
    }));
}

/// A single fake spawned by [`MultiSpawnOverrideGuard`]. Kept inspectable so
/// warm-cap tests can compare ports/session ids and per-daemon call logs.
#[derive(Clone)]
pub struct SpawnedFakeDaemon {
    pub session_id: String,
    pub port: u16,
    fake: Arc<FakeDaemon>,
}

impl std::fmt::Debug for SpawnedFakeDaemon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpawnedFakeDaemon")
            .field("session_id", &self.session_id)
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl SpawnedFakeDaemon {
    /// Every `(method, path)` the driver made to this fake, in arrival order.
    pub fn recorded_calls(&self) -> Vec<(String, String)> {
        self.fake.recorded_calls()
    }

    /// True iff the driver made a call matching `method` + `path` to this fake.
    pub fn called(&self, method: &str, path: &str) -> bool {
        self.fake.called(method, path)
    }
}

#[derive(Default)]
struct MultiSpawnState {
    spawned: Vec<SpawnedFakeDaemon>,
    opts: Vec<SpawnDaemonOpts>,
    warm: BTreeSet<String>,
    closed: BTreeSet<String>,
}

/// Inspectable handle for a multi-spawn override. Clone it into the test body;
/// the guard owns override cleanup, while this handle exposes what happened.
#[derive(Clone)]
pub struct MultiSpawnHandle {
    state: Arc<Mutex<MultiSpawnState>>,
}

impl MultiSpawnHandle {
    /// Fakes spawned so far, in spawn/new-session order.
    pub fn spawned(&self) -> Vec<SpawnedFakeDaemon> {
        self.state.lock().spawned.clone()
    }

    /// `SpawnDaemonOpts` captured for each override invocation.
    pub fn captured_opts(&self) -> Vec<SpawnDaemonOpts> {
        self.state.lock().opts.clone()
    }

    /// Session ids the test observed as still warm. Phase 5 can feed this with
    /// the hub/driver-visible warm set after driving `cap+1` sessions.
    pub fn mark_warm_sessions<I>(&self, session_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        self.state.lock().warm = session_ids.into_iter().collect();
    }

    /// Last warm-set snapshot supplied through [`Self::mark_warm_sessions`].
    pub fn warm_sessions(&self) -> Vec<String> {
        self.state.lock().warm.iter().cloned().collect()
    }

    /// Record session ids whose `SessionClosed` event a test observed.
    pub fn mark_session_closed<I>(&self, session_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        self.state.lock().closed = session_ids.into_iter().collect();
    }

    /// Last `SessionClosed` snapshot supplied through [`Self::mark_session_closed`].
    pub fn session_closed(&self) -> Vec<String> {
        self.state.lock().closed.iter().cloned().collect()
    }
}

/// Multi-spawn override guard: every spawn invocation starts a fresh fake daemon
/// on a fresh ephemeral port and returns its minted session id to the driver.
pub struct MultiSpawnOverrideGuard {
    handle: MultiSpawnHandle,
}

impl MultiSpawnOverrideGuard {
    /// Install a multi-spawn override. The caller must hold the test binary's
    /// process-global override mutex for the full guard lifetime.
    pub fn install(scenario: ScenarioFile, session_prefix: impl Into<String>) -> Self {
        Self::install_with_delay(scenario, session_prefix, 0)
    }

    /// Same as [`Self::install`], with explicit SSE inter-frame delay.
    pub fn install_with_delay(
        scenario: ScenarioFile,
        session_prefix: impl Into<String>,
        inter_frame_delay_ms: u64,
    ) -> Self {
        let state = Arc::new(Mutex::new(MultiSpawnState::default()));
        let handle = MultiSpawnHandle {
            state: state.clone(),
        };
        let session_prefix = session_prefix.into();
        let scenario = Arc::new(scenario);

        set_spawn_override(Arc::new(move |_bin: &str, opts: SpawnDaemonOpts| {
            let state = state.clone();
            let scenario = scenario.clone();
            let session_prefix = session_prefix.clone();
            Box::pin(async move {
                let idx = {
                    let mut state = state.lock();
                    state.opts.push(opts.clone());
                    state.opts.len()
                };
                let session_id = format!("{session_prefix}-{idx}");
                let fake = Arc::new(
                    spawn(
                        (*scenario).clone(),
                        session_id.clone(),
                        inter_frame_delay_ms,
                    )
                    .await,
                );
                let port = fake.port;
                let spawned = SpawnedFakeDaemon {
                    session_id: session_id.clone(),
                    port,
                    fake,
                };
                state.lock().spawned.push(spawned);
                Ok((
                    SpawnedDaemon {
                        session_id,
                        port,
                        auth_token: None,
                    },
                    None,
                ))
            })
        }));

        Self { handle }
    }

    pub fn handle(&self) -> MultiSpawnHandle {
        self.handle.clone()
    }
}

impl Drop for MultiSpawnOverrideGuard {
    fn drop(&mut self) {
        clear_spawn_override();
    }
}

/// Build the axum router. One catch-all `any` handler dispatches recorded vs
/// canned vs unmatched; `GET /events` is a dedicated SSE route.
fn build_router(
    state: Arc<Mutex<FakeState>>,
    scenario: Arc<ScenarioFile>,
    sse_mode: SseMode,
) -> Router {
    Router::new()
        .route("/events", get(sse_handler))
        .fallback(any(http_handler))
        .with_state(AppState {
            state,
            scenario,
            sse_mode,
        })
}

#[derive(Clone)]
struct AppState {
    state: Arc<Mutex<FakeState>>,
    scenario: Arc<ScenarioFile>,
    sse_mode: SseMode,
}

fn frame_to_event(frame: &corpus::SseFrame) -> Event {
    let mut event =
        Event::default().data(serde_json::to_string(frame).expect("serialize sse frame"));
    if let Some(seq) = frame.seq {
        event = event.id(seq.to_string());
    }
    event
}

/// The SSE handler: one-shot test mode streams the spawn scenario immediately;
/// controlled fake mode holds the stream open and waits for `FakeControl` pushes.
/// Strict fakes treat the stream connection as an ordered request expectation,
/// while loose historical corpus replay only records it.
async fn sse_handler(State(app): State<AppState>) -> Response {
    let contract_error = {
        let mut state = app.state.lock();
        state.calls.push(("GET".to_string(), "/events".to_string()));
        state
            .request_bodies
            .push(("GET".to_string(), "/events".to_string(), String::new()));
        let scenario = state
            .scenario_override
            .clone()
            .unwrap_or_else(|| app.scenario.clone());
        if state.strict {
            match match_http_expectation(
                &scenario,
                state.next_http_expectation,
                "GET",
                "/events",
                "",
            ) {
                Ok(Some(entry)) => {
                    state.next_http_expectation += 1;
                    // A declared non-200 `/events` entry (auth-failure
                    // contracts) is served as a plain error response instead of
                    // a stream — the attach failure tests exercise exactly the
                    // client's non-200 handling.
                    if entry.status != 200 {
                        Some((
                            StatusCode::from_u16(entry.status as u16)
                                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                            entry
                                .response_body
                                .map(|v| v.to_string())
                                .unwrap_or_default(),
                        ))
                    } else {
                        None
                    }
                }
                Ok(None) if state.allow_bootstrap => None,
                Ok(None) => Some((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "strict fake contract has no expectation for GET /events".into(),
                )),
                Err(error) => Some((StatusCode::INTERNAL_SERVER_ERROR, error)),
            }
        } else {
            None
        }
    };
    if let Some((status, body)) = contract_error {
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!("fake daemon contract violation: {body}");
        }
        return (status, body).into_response();
    }

    let (tx, rx) = mpsc::channel::<Result<Event, std::convert::Infallible>>(64);
    match app.sse_mode.clone() {
        SseMode::OneShot {
            inter_frame_delay_ms,
        } => {
            let frames = app.scenario.sse.clone();
            tokio::spawn(async move {
                for frame in frames {
                    if tx.send(Ok(frame_to_event(&frame))).await.is_err() {
                        break;
                    }
                    if inter_frame_delay_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(inter_frame_delay_ms))
                            .await;
                    }
                }
            });
        }
        SseMode::Controlled => {
            app.state.lock().sse_tx = Some(tx);
        }
        SseMode::Gated { tx: slot } => {
            *slot.lock() = Some(tx);
        }
        SseMode::HydrationRace { frame, control } => {
            tokio::spawn(async move {
                control.wait_state_requested().await;
                if tx.send(Ok(frame_to_event(&frame))).await.is_ok() {
                    control.event_sent.add_permits(1);
                }
                tx.closed().await;
                control.stream_closed.add_permits(1);
            });
        }
    }
    Sse::new(ReceiverStream::new(rx)).into_response()
}

/// The catch-all HTTP handler: record the call, then resolve a response from
/// the canned set, the recorded `http[]` entries, or fail loud (500).
async fn http_handler(
    State(app): State<AppState>,
    Query(_q): Query<QueryParams>,
    req: Request,
) -> Response {
    let method = req.method().to_string();
    // Keep the normalized path+query as the contract key. This preserves query
    // matching for declared expectations and prevents bootstrap fallbacks from
    // silently accepting an undeclared query-bearing request.
    let path = req.uri().path_and_query().map_or_else(
        || req.uri().path().to_string(),
        |value| value.as_str().to_string(),
    );
    let request_body = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default();

    // The race test holds the authoritative snapshot after the request arrives.
    // Its SSE producer waits for this signal, guaranteeing the event is emitted
    // while hydration is still incomplete rather than merely before installation.
    if method == "GET" && path == "/state" {
        if let SseMode::HydrationRace { control, .. } = &app.sse_mode {
            // One permit for the SSE producer and one for the test observer.
            control.state_requested.add_permits(2);
            HydrationRaceControl::wait(&control.release_state).await;
        }
    }

    // Record the call (lock held only for the push + cursor advance).
    let (status, body) = {
        let mut st = app.state.lock();
        st.calls.push((method.clone(), path.clone()));
        st.request_bodies
            .push((method.clone(), path.clone(), request_body.clone()));
        let scenario = st
            .scenario_override
            .clone()
            .unwrap_or_else(|| app.scenario.clone());
        if st.strict {
            match match_http_expectation(
                &scenario,
                st.next_http_expectation,
                &method,
                &path,
                &request_body,
            ) {
                Ok(Some(entry)) => {
                    st.next_http_expectation += 1;
                    (
                        StatusCode::from_u16(entry.status as u16)
                            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                        entry.response_body.clone(),
                    )
                }
                Ok(None) => {
                    if st.allow_bootstrap {
                        if let Some((code, value)) = canned(&method, &path) {
                            (code, Some(value))
                        } else {
                            let error = format!(
                                "strict fake contract has no expectation for {method} {path}"
                            );
                            tracing::error!("fake daemon contract violation: {error}");
                            return (StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
                        }
                    } else {
                        let error =
                            format!("strict fake contract has no expectation for {method} {path}");
                        tracing::error!("fake daemon contract violation: {error}");
                        return (StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
                    }
                }
                Err(error) => {
                    tracing::error!("fake daemon contract violation: {error}");
                    return (StatusCode::INTERNAL_SERVER_ERROR, error).into_response();
                }
            }
        } else {
            let key = (method.clone(), path.clone());
            let idx = st.cursors.get(&key).copied().unwrap_or(0);
            let recording = scenario
                .http
                .iter()
                .filter(|entry| entry.method == method && entry.path == path)
                .nth(idx)
                .cloned();
            if let Some(entry) = recording {
                st.cursors.insert(key, idx + 1);
                (
                    StatusCode::from_u16(entry.status as u16)
                        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                    entry.response_body.clone(),
                )
            } else if let Some((code, value)) = canned(&method, &path) {
                (code, Some(value))
            } else {
                tracing::error!("fake daemon: unmatched request {} {}", method, path);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Some(Value::String(format!("unmatched request: {method} {path}"))),
                )
            }
        }
    };

    let mut resp = body
        .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "{}".into()))
        .unwrap_or_default()
        .into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    *resp.status_mut() = status;
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scenario(http: Value) -> ScenarioFile {
        serde_json::from_value(serde_json::json!({
            "scenario": "strict-test", "version": "test",
            "provenance": {"kind": "synthetic_pantoken_regression"},
            "description": "strict fake daemon matcher test",
            "canonicalization": {"session_id": "S", "prompt_ids": {}, "timestamps": "fixed"},
            "http": http, "sse": [], "expected_driver_events": {"capabilities": [], "events": [], "effects": [], "final_session": {"mapped_event_count": 0, "assistant_delta_count": 0, "open_block_count": 0, "tool_input_buffer_empty": true, "turn_error_present": false}, "required_requests": [], "forbidden_requests": []}
        }))
        .unwrap()
    }

    #[test]
    fn fake_daemon_rejects_unexpected_request() {
        let s = scenario(serde_json::json!([
            {"method":"GET","path":"/state","status":200},
            {"method":"GET","path":"/history","status":200}
        ]));
        let err = match_http_expectation(&s, 0, "GET", "/history", "").unwrap_err();
        assert!(err.contains("request order mismatch"));
    }

    #[test]
    fn fake_daemon_checks_body_order_and_count() {
        let s = scenario(serde_json::json!([
            {"method":"POST","path":"/prompt","request_body":{"text":"a"},"status":202},
            {"method":"GET","path":"/state","status":200}
        ]));
        let err = match_http_expectation(&s, 0, "POST", "/prompt", r#"{"text":"b"}"#).unwrap_err();
        assert!(err.contains("request body mismatch"));
        let err = match_http_expectation(&s, 0, "GET", "/state", "").unwrap_err();
        assert!(err.contains("request order mismatch"));
        assert!(match_http_expectation(&s, 0, "POST", "/prompt", r#"{"text":"a"}"#).is_ok());
        assert!(match_http_expectation(&s, 1, "GET", "/state", "").is_ok());
        let err = match_http_expectation(&s, 2, "GET", "/state", "").unwrap_err();
        assert!(err.contains("unexpected extra request"));
    }

    #[tokio::test]
    async fn strict_fake_accounts_for_sse_expectation() {
        let fake = spawn_strict(
            scenario(serde_json::json!([
                {"method":"GET","path":"/events","status":200}
            ])),
            "strict-sse".into(),
            0,
        )
        .await;
        let response = reqwest::get(format!("http://127.0.0.1:{}/events", fake.port))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(fake.called("GET", "/events"));
        fake.assert_expectations_consumed().unwrap();

        let missing = spawn_strict(scenario(serde_json::json!([])), "missing-sse".into(), 0).await;
        let response = reqwest::get(format!("http://127.0.0.1:{}/events", missing.port))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        missing.assert_expectations_consumed().unwrap();

        let ordered = scenario(serde_json::json!([
            {"method":"GET","path":"/state","status":200},
            {"method":"GET","path":"/events","status":200}
        ]));
        let error = match_http_expectation(&ordered, 0, "GET", "/events", "").unwrap_err();
        assert!(error.contains("request order mismatch"), "{error}");
    }

    #[tokio::test]
    async fn fake_daemon_fails_on_unconsumed_expectation() {
        let fake = spawn_strict(
            scenario(serde_json::json!([
                {"method":"GET","path":"/state","status":200},
                {"method":"GET","path":"/history","status":200}
            ])),
            "strict-consumption".into(),
            0,
        )
        .await;
        let base = format!("http://127.0.0.1:{}", fake.port);
        reqwest::get(format!("{base}/state")).await.unwrap();
        let error = fake.assert_expectations_consumed().unwrap_err();
        assert!(error.contains("1 unconsumed"), "{error}");
        reqwest::get(format!("{base}/history")).await.unwrap();
        fake.assert_expectations_consumed().unwrap();
    }

    fn race_frame() -> corpus::SseFrame {
        corpus::SseFrame {
            seq: Some(1),
            emitted_at: "1970-01-01T00:00:00.000Z".into(),
            session_id: "S".into(),
            event: serde_json::json!({"type": "message_start", "prompt_id": "PROMPT_0"}),
        }
    }

    #[tokio::test]
    async fn strict_hydration_race_rejects_undeclared_request() {
        let (fake, _race) = spawn_strict_hydration_race(
            scenario(serde_json::json!([
                {"method":"GET","path":"/events","status":200}
            ])),
            "strict-race".into(),
            race_frame(),
        )
        .await;
        let base = format!("http://127.0.0.1:{}", fake.port);
        // The declared /events expectation connects (the race gate then holds
        // the frame until /state enters).
        let response = reqwest::get(format!("{base}/events")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        // /history is neither declared nor canned → the strict race fake must
        // reject it (500), exactly like the strict one-shot fake.
        let response = reqwest::get(format!("{base}/history")).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        // /health stays on the canned bootstrap allowlist.
        let response = reqwest::get(format!("{base}/health")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        fake.assert_expectations_consumed().unwrap();
    }

    #[tokio::test]
    async fn strict_sse_serves_declared_error_status() {
        // A declared non-200 `/events` entry must be served as that error
        // response (not a stream): the attach-failure contracts exercise the
        // client's `GET /events failed (401)` path through this seam.
        let fake = spawn_strict(
            scenario(serde_json::json!([
                {
                    "method": "GET",
                    "path": "/events",
                    "status": 401,
                    "response_body": {"code": "unauthorized", "message": "bad token"}
                }
            ])),
            "strict-sse-401".into(),
            0,
        )
        .await;
        let response = reqwest::get(format!("http://127.0.0.1:{}/events", fake.port))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = response.text().await.unwrap();
        assert!(body.contains("unauthorized"), "{body}");
        fake.assert_expectations_consumed().unwrap();
    }

    #[tokio::test]
    async fn gated_stream_delivers_pushed_frames_and_ends_on_close() {
        use futures_util::StreamExt;
        let (fake, gate) = spawn_strict_gated(
            scenario(serde_json::json!([
                {"method":"GET","path":"/events","status":200}
            ])),
            "gated".into(),
        )
        .await;
        let response = reqwest::get(format!("http://127.0.0.1:{}/events", fake.port))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut stream = response.bytes_stream();

        gate.push(corpus::SseFrame {
            seq: Some(1),
            emitted_at: "1970-01-01T00:00:00.000Z".into(),
            session_id: "S".into(),
            event: serde_json::json!({"type": "heartbeat"}),
        })
        .await
        .expect("push onto the connected stream");

        let first = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
            .await
            .expect("pushed frame must arrive")
            .expect("stream must not end early")
            .expect("frame bytes");
        let text = String::from_utf8_lossy(&first);
        assert!(text.contains("heartbeat"), "{text}");

        gate.close();
        let ended = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
            .await
            .expect("close must end the stream promptly");
        assert!(ended.is_none(), "stream must end after close");

        // Pushing after close fails loudly (no connected stream).
        assert!(gate.push(race_frame()).await.is_err());
        fake.assert_expectations_consumed().unwrap();
    }

    #[tokio::test]
    async fn bootstrap_allowlist_has_contract_tests() {
        assert!(canned("GET", "/health").is_some());
        assert!(canned("POST", "/tui-attachment/claim").is_some());
        assert!(canned("POST", "/tui-attachment/heartbeat").is_some());
        assert!(canned("DELETE", "/tui-attachment/lease-1").is_some());
        assert!(canned("DELETE", "/tui-attachment/a-b_c.1").is_some());
        for path in [
            "/tui-attachment/",
            "/tui-attachment/lease-1/extra",
            "/tui-attachment//lease-1",
            "/tui-attachmentary/lease-1",
            "/not-in-allowlist",
        ] {
            assert!(
                canned("DELETE", path).is_none(),
                "unexpected bootstrap path: {path}"
            );
        }

        let empty = scenario(serde_json::json!([]));
        let strict = spawn_strict(empty.clone(), "strict-no-bootstrap".into(), 0).await;
        let response = reqwest::get(format!("http://127.0.0.1:{}/health", strict.port))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        strict.assert_expectations_consumed().unwrap();

        let wrapped =
            spawn_strict_with_bootstrap(empty.clone(), "strict-with-bootstrap".into(), 0).await;
        let response = reqwest::get(format!("http://127.0.0.1:{}/health", wrapped.port))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = reqwest::Client::new()
            .delete(format!(
                "http://127.0.0.1:{}/tui-attachment/lease-1?unexpected=1",
                wrapped.port
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        wrapped.assert_expectations_consumed().unwrap();

        let declared_query = scenario(serde_json::json!([
            {
                "method": "DELETE",
                "path": "/tui-attachment/lease-1?expected=1",
                "status": 204
            }
        ]));
        let declared =
            spawn_strict_with_bootstrap(declared_query, "declared-query".into(), 0).await;
        let response = reqwest::Client::new()
            .delete(format!(
                "http://127.0.0.1:{}/tui-attachment/lease-1?expected=1",
                declared.port
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        declared.assert_expectations_consumed().unwrap();
    }
}
