//! Golden daemon corpus loader + canonicalization tests.
//!
//! See `server-rs/tests/corpus/0.5.8/README.md` for the format. The
//! correctness bar: every seed event in every scenario's `sse[]` MUST deserialize
//! into the real `pantoken_daemon_types::SseEnvelope` / `DaemonEvent` — the loader test
//! enforces this, so a daemon event-shape drift fails loud (no silent fallbacks).
//!
//! Canonicalization is idempotent: running it on already-canonical data yields
//! identical output. The seed fixtures ship pre-canonicalized; the capture script
//! canonicalizes real captures before writing. The test asserts replay
//! determinism by running canonicalization twice and comparing.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use pantoken_daemon_types::SseEnvelope;
use pantoken_protocol::session_driver::{
    SessionDriverEvent, SessionRef, SessionStatus, WorkspaceRef,
};
use pantoken_server::polytoken::event_map::{self, DaemonEffect, MapCtx};
use serde_json::Value;

mod support;
// The loader structs (`ScenarioFile`/`HttpEntry`/`SseFrame`/`CanonicalizationManifest`)
// + helpers (`load_scenario`/`scenario_files`/`version_dirs`/`corpus_dir`) live in
// `support::corpus` and are shared with the fake-daemon harness. The
// canonicalization machinery below is corpus-test-only.
use support::corpus::{
    CanonicalizationManifest, DriverEffectExpectation, FinalSessionInvariants, FixtureProvenance,
    FixtureProvenanceKind, HttpEntry, ScenarioFile, SseFrame, corpus_dir, load_scenario,
    scenario_files, version_dirs,
};

// ---------------------------------------------------------------------------
// Canonicalization
//
// The seed fixtures ship pre-canonicalized, but real captures have raw session
// ids, prompt ids (UUIDs), and wall-clock timestamps. Canonicalization rewrites
// them to stable placeholders so a corpus replay is deterministic across runs.
//
//   session_id     → "SESSION"
//   prompt_id (UUID-like, not already a placeholder) → "PROMPT_0", "PROMPT_1", … (first-seen order)
//   timestamps     → monotonic epoch starting 1970-01-01T00:00:00.000Z, +1s per frame
//   /state leaks   → type-preserving placeholders for env/token/text/cwd/source_control
//
// Idempotency: a value already matching a placeholder (`SESSION`, `PROMPT_\d+`,
// the monotonic epoch, or a /state redaction placeholder) is left untouched, so
// re-running on canonicalized data is a no-op. The test asserts this.
// ---------------------------------------------------------------------------

/// True if `s` is already a canonical prompt placeholder (`PROMPT_N`).
fn is_prompt_placeholder(s: &str) -> bool {
    s.starts_with("PROMPT_") && s[7..].chars().all(|c| c.is_ascii_digit()) && s.len() > 7
}

/// True if `s` is the canonical session placeholder.
fn is_session_placeholder(s: &str) -> bool {
    s == "SESSION"
}

/// True if `s` is a canonical monotonic-epoch timestamp — any
/// `1970-01-01THH:MM:SS.000Z` (the monotonic sequence can roll past 00:00:59 on a
/// long capture; matching the full epoch prefix, not just `00:00:`, keeps the
/// idempotency check valid for ≥60-frame corpora — review C2).
fn is_monotonic_epoch(s: &str) -> bool {
    s.starts_with("1970-01-01T") && s.ends_with(".000Z") && s.len() == 24
}

/// The canonicalization state: the session-id map and the prompt-id map built
/// during a canonicalize pass. Owned by `canonicalize_value`.
#[derive(Default)]
struct CanonState {
    /// Maps a real session id → "SESSION". (Single-session corpus; one placeholder.)
    session_ids: HashMap<String, String>,
    /// Maps a real prompt id → "PROMPT_N" in first-seen order.
    prompt_ids: HashMap<String, String>,
    /// Next PROMPT_N index to assign.
    next_prompt: usize,
}

impl CanonState {
    /// Map a session id to its placeholder, registering it if new.
    fn canon_session(&mut self, raw: &str) -> String {
        if is_session_placeholder(raw) {
            return raw.to_string();
        }
        self.session_ids
            .entry(raw.to_string())
            .or_insert_with(|| "SESSION".to_string())
            .clone()
    }

    /// Map a prompt id to its placeholder, DEDUPED in first-seen order: the same
    /// raw id (a prompt id recurs across message_start, content_block_*,
    /// message_complete, and the PromptAccepted HTTP body) must map to ONE
    /// `PROMPT_N`, not a fresh one per occurrence. Caller is responsible for only
    /// calling this for values that ARE prompt ids (keys named `prompt_id` or
    /// ending in `_prompt_id` or `_prompt_ids`); we do NOT guess from UUID shape,
    /// since item_ids, call_id, and interrogative_id can also be UUID-shaped and
    /// must be left as-is (review C3).
    fn canon_prompt(&mut self, raw: &str) -> String {
        if is_prompt_placeholder(raw) {
            return raw.to_string();
        }
        if let Some(existing) = self.prompt_ids.get(raw) {
            return existing.clone();
        }
        let n = self.next_prompt;
        self.next_prompt += 1;
        let placeholder = format!("PROMPT_{}", n);
        self.prompt_ids.insert(raw.to_string(), placeholder.clone());
        placeholder
    }

    /// The real→placeholder prompt-id map as a sorted `BTreeMap`, for the scenario's
    /// canonicalization manifest (deterministic serialization across runs).
    fn prompt_manifest(&self) -> std::collections::BTreeMap<String, String> {
        self.prompt_ids
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

/// Recursively walk a JSON value, rewriting session ids, prompt ids, and
/// timestamps in place. `prompt_keys` lists object keys whose string values are
/// prompt ids (so they get placeholder-mapped rather than left as opaque
/// strings). `session_keys` lists keys whose string values are session ids.
fn canonicalize_value(v: &mut Value, state: &mut CanonState) {
    match v {
        Value::Object(map) => {
            // Collect keys+values to mutate without borrowing map during iteration.
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                if let Some(child) = map.get_mut(&key) {
                    // Session-id key → the single "SESSION" placeholder (single-session
                    // corpus). Handles session_id wherever it's nested (event payloads,
                    // HTTP bodies), not just on the SSE envelope.
                    if key == "session_id" {
                        if let Value::String(s) = child {
                            *s = state.canon_session(s);
                        }
                        continue;
                    }
                    // /state leak redactions are KEY-driven and type-preserving. These
                    // keys appear only in HTTP /state bodies in the golden corpus, but the
                    // recursive canonicalizer handles them wherever they are nested so a
                    // future capture cannot leak machine paths, model output, or counters.
                    if key == "env" {
                        if matches!(child, Value::Object(_)) {
                            *child = Value::Object(serde_json::Map::new());
                        }
                        continue;
                    }
                    if key == "most_recent_assistant_text" {
                        if let Value::String(s) = child {
                            s.clear();
                        }
                        continue;
                    }
                    if key == "used_tokens" {
                        if let Value::Number(_) = child {
                            *child = Value::Number(0.into());
                        }
                        continue;
                    }
                    if key == "project_cwd" {
                        if let Value::String(s) = child {
                            *s = "/PROJECT".to_string();
                        }
                        continue;
                    }
                    if key == "source_control" {
                        if let Value::Object(sc) = child {
                            if matches!(sc.get("label"), Some(Value::String(_))) {
                                sc.insert("label".to_string(), Value::String("BRANCH".to_string()));
                            }
                            if matches!(sc.get("dirty"), Some(Value::Bool(_))) {
                                sc.insert("dirty".to_string(), Value::Bool(false));
                            }
                            for leaf in ["commit", "sha", "revision", "head", "upstream"] {
                                if matches!(sc.get(leaf), Some(Value::String(_))) {
                                    sc.insert(
                                        leaf.to_string(),
                                        Value::String("COMMIT".to_string()),
                                    );
                                }
                            }
                        }
                        continue;
                    }
                    // Prompt-id key → PROMPT_N (deduped). Matches BOTH singular
                    // (`prompt_id`, `admission_prompt_id`, `final_prompt_id`,
                    // `to_prompt_id`, …) AND plural (`admission_prompt_ids`,
                    // `prompt_ids`). Singular → the string maps directly; plural →
                    // each STRING element of the array maps directly. We map on the KEY,
                    // never on UUID shape alone, so a UUID-shaped `item_ids`/`call_id`
                    // is left untouched (review C3: shape-based mapping corrupted
                    // non-prompt ids + inflated the counter).
                    let is_prompt_field = key == "prompt_id"
                        || key.ends_with("_prompt_id")
                        || key.ends_with("_prompt_ids");
                    if is_prompt_field {
                        match child {
                            Value::String(s) => *s = state.canon_prompt(s),
                            // Plural `*_prompt_ids`: map each string element in place.
                            // Recursing via canonicalize_value here would DROP the key
                            // context (array elements aren't "under a prompt key"), so the
                            // UUIDs would fall through to the bare-scalar arm and stay raw —
                            // a real capture's `admission_prompt_ids` leaked un-canonicalized
                            // exactly this way.
                            Value::Array(arr) => {
                                for elem in arr.iter_mut() {
                                    match elem {
                                        Value::String(s) => *s = state.canon_prompt(s),
                                        _ => canonicalize_value(elem, state),
                                    }
                                }
                            }
                            Value::Object(_) => canonicalize_value(child, state),
                            _ => {}
                        }
                        continue;
                    }
                    // Other arrays/objects: recurse.
                    if matches!(child, Value::Object(_) | Value::Array(_)) {
                        canonicalize_value(child, state);
                    }
                }
            }
        }
        Value::Array(arr) => {
            for child in arr.iter_mut() {
                canonicalize_value(child, state);
            }
        }
        // Bare scalars (string/number/bool/null) under a non-prompt key are left
        // untouched. We deliberately do NOT map a UUID-shaped string here: whether a
        // UUID is a prompt id, call_id, item_id, or interrogative_id is determined by
        // its parent KEY (handled above), not its shape. Shape-based mapping corrupted
        // non-prompt UUIDs (review C3) and broke cross-reference fidelity.
        _ => {}
    }
}

/// Canonicalize one SSE frame: rewrite the session_id, the emitted_at timestamp
/// to a monotonic epoch, and recursively rewrite ids inside `event`. `frame_idx`
/// seeds the monotonic timestamp (frame 0 → T0, frame N → T0+N seconds).
fn canonicalize_frame(frame: &mut SseFrame, frame_idx: usize, state: &mut CanonState) {
    // Session id on the envelope.
    frame.session_id = state.canon_session(&frame.session_id);

    // emitted_at → monotonic epoch, unless already canonical.
    if !is_monotonic_epoch(&frame.emitted_at) {
        frame.emitted_at = monotonic_timestamp(frame_idx);
    }

    // Recurse into the event payload.
    canonicalize_value(&mut frame.event, state);

    // The event's inner `timestamp` field (heartbeat / system_reminder carry one)
    // — rewrite to match the frame's emitted_at if not already canonical.
    if let Value::Object(map) = &mut frame.event {
        if let Some(Value::String(ts)) = map.get_mut("timestamp") {
            if !is_monotonic_epoch(ts) {
                *ts = monotonic_timestamp(frame_idx);
            }
        }
        // The event's inner `emitted_at` field (some daemon events carry one) —
        // rewrite to match the frame's emitted_at if not already canonical.
        if let Some(Value::String(ts)) = map.get_mut("emitted_at") {
            if !is_monotonic_epoch(ts) {
                *ts = monotonic_timestamp(frame_idx);
            }
        }
    }
}

/// Canonicalize the HTTP entries: rewrite session ids, prompt ids, and
/// timestamps inside request/response bodies.
fn canonicalize_http(http: &mut [HttpEntry], state: &mut CanonState) {
    for entry in http.iter_mut() {
        if let Some(body) = &mut entry.request_body {
            canonicalize_value(body, state);
        }
        if let Some(body) = &mut entry.response_body {
            canonicalize_value(body, state);
        }
    }
}

/// The Nth monotonic-epoch timestamp: `1970-01-01THH:MM:SS.000Z`, where the frame
/// index is interpreted as elapsed seconds (frame 0 → epoch, frame N → +N seconds).
/// Rolls over into minutes/hours so a ≥60-frame corpus stays a valid 24-char
/// stamp that `is_monotonic_epoch` recognizes (review C2: capping at 59s broke
/// idempotency on the 2nd pass for long captures).
fn monotonic_timestamp(frame_idx: usize) -> String {
    let total = frame_idx as u64;
    let secs = total % 60;
    let mins = (total / 60) % 60;
    let hours = (total / 3600) % 24;
    format!("1970-01-01T{:02}:{:02}:{:02}.000Z", hours, mins, secs)
}

/// Canonicalize a full scenario in place: HTTP bodies + SSE frames, then write the
/// real→placeholder prompt-id map back into the scenario's canonicalization
/// manifest (so the manifest is a true record of what was canonicalized, not a
/// hand-maintained field). Idempotent: the map is empty after a 2nd pass because
/// every id is already a placeholder — but the manifest is written from the
/// FIRST pass's state, so re-running over an already-canonical scenario leaves
/// the manifest unchanged (placeholder→placeholder is a no-op that allocates none).
fn canonicalize_scenario(scenario: &mut ScenarioFile) {
    let mut state = CanonState::default();
    canonicalize_http(&mut scenario.http, &mut state);
    for (idx, frame) in scenario.sse.iter_mut().enumerate() {
        canonicalize_frame(frame, idx, &mut state);
    }
    // Reflect the canonicalization scheme into the manifest (sorted for determinism —
    // BTreeMap serializes in key order).
    scenario.canonicalization.session_id = "SESSION".to_string();
    scenario.canonicalization.prompt_ids = state.prompt_manifest();
    scenario.canonicalization.timestamps = "monotonic-from-T0".to_string();
}

// ---------------------------------------------------------------------------
// Corpus loading helpers — re-exported from `support::corpus` (shared with the
// fake-daemon harness). The canonicalization functions above are the only
// corpus-test-private code.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Typed Pantoken-boundary contract replay
// ---------------------------------------------------------------------------

struct ContractCtx {
    r#ref: SessionRef,
    workspace: WorkspaceRef,
}
impl Default for ContractCtx {
    fn default() -> Self {
        Self {
            r#ref: SessionRef {
                workspace_id: "W".into(),
                session_id: "SESSION".into(),
            },
            workspace: WorkspaceRef {
                workspace_id: "W".into(),
                path: "/PROJECT".into(),
                display_name: None,
            },
        }
    }
}
impl MapCtx for ContractCtx {
    fn r#ref(&self) -> &SessionRef {
        &self.r#ref
    }
    fn workspace(&self) -> &WorkspaceRef {
        &self.workspace
    }
    fn now(&self) -> String {
        "1970-01-01T00:00:00.000Z".into()
    }
    fn snapshot(
        &self,
        status: SessionStatus,
    ) -> pantoken_protocol::session_driver::SessionSnapshot {
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
    fn live_status(&self) -> SessionStatus {
        SessionStatus::Idle
    }
}

fn effect_expectation(effect: &DaemonEffect) -> DriverEffectExpectation {
    match effect {
        DaemonEffect::FetchState { emit, prompt_id } => DriverEffectExpectation {
            kind: "fetchState".into(),
            emit: Some(format!("{emit:?}")),
            prompt_id: prompt_id.clone(),
        },
        DaemonEffect::Reseed => DriverEffectExpectation {
            kind: "reseed".into(),
            emit: None,
            prompt_id: None,
        },
        DaemonEffect::RefetchQueue => DriverEffectExpectation {
            kind: "refetchQueue".into(),
            emit: None,
            prompt_id: None,
        },
        DaemonEffect::SetMonitorMode { .. } => DriverEffectExpectation {
            kind: "setMonitorMode".into(),
            emit: None,
            prompt_id: None,
        },
        DaemonEffect::SetAutodrainEnabled { .. } => DriverEffectExpectation {
            kind: "setAutodrainEnabled".into(),
            emit: None,
            prompt_id: None,
        },
        DaemonEffect::RegisterInterrogative { .. } => DriverEffectExpectation {
            kind: "registerInterrogative".into(),
            emit: None,
            prompt_id: None,
        },
    }
}

fn replay_contract(
    scenario: &ScenarioFile,
) -> (
    Vec<SessionDriverEvent>,
    Vec<DriverEffectExpectation>,
    event_map::FoldAccumulator,
) {
    let ctx = ContractCtx::default();
    let mut acc = event_map::create_accumulator();
    let mut events = Vec::new();
    let mut effects = Vec::new();
    for frame in &scenario.sse {
        let envelope = frame
            .envelope()
            .unwrap_or_else(|e| panic!("{}: {e}", scenario.scenario));
        let result = event_map::map_daemon_event(&envelope.event, &mut acc, &ctx);
        events.extend(result.events);
        effects.extend(result.effects.iter().map(effect_expectation));
    }
    (events, effects, acc)
}

fn subset(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(actual), Value::Object(expected)) => expected
            .iter()
            .all(|(key, value)| actual.get(key).is_some_and(|a| subset(a, value))),
        (Value::Array(actual), Value::Array(expected)) => {
            expected.len() <= actual.len() && expected.iter().zip(actual).all(|(e, a)| subset(a, e))
        }
        _ => actual == expected,
    }
}

fn assert_contract(scenario: &ScenarioFile) {
    let (events, effects, acc) = replay_contract(scenario);
    let actual_events: Vec<Value> = events
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    let expected = &scenario.expected_driver_events;
    assert!(
        !expected.events.is_empty(),
        "{}: committed contract event sequence is empty",
        scenario.scenario
    );
    let mut cursor = 0;
    for contract in &expected.events {
        let mut matched = 0;
        while cursor < actual_events.len() && matched < contract.count {
            let actual = &actual_events[cursor];
            cursor += 1;
            if actual["type"] == contract.kind
                && contract.essential.as_ref().is_none_or(|fields| {
                    subset(
                        actual,
                        &Value::Object(
                            fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                        ),
                    )
                })
            {
                matched += 1;
            }
        }
        assert_eq!(
            matched, contract.count,
            "{}: exact ordered event contract failed at {}",
            scenario.scenario, contract.kind
        );
    }
    assert_eq!(
        cursor,
        actual_events.len(),
        "{}: unexpected mapped events: {:?}",
        scenario.scenario,
        actual_events
    );
    assert_eq!(
        effects, expected.effects,
        "{}: exact effect sequence mismatch",
        scenario.scenario
    );
    let inv = &expected.final_session;
    assert_eq!(
        events.len(),
        inv.mapped_event_count,
        "{}: mapped event count",
        scenario.scenario
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, SessionDriverEvent::AssistantDelta { .. }))
            .count(),
        inv.assistant_delta_count,
        "{}: assistant delta count",
        scenario.scenario
    );
    assert_eq!(
        usize::from(acc.block_kind.is_some()),
        inv.open_block_count,
        "{}: open block invariant",
        scenario.scenario
    );
    assert_eq!(
        acc.tool_input_buffer.is_empty(),
        inv.tool_input_buffer_empty,
        "{}: tool input buffer invariant",
        scenario.scenario
    );
    assert_eq!(
        acc.turn_error.is_some(),
        inv.turn_error_present,
        "{}: turn error invariant",
        scenario.scenario
    );
}

#[test]
fn corpus_provenance_is_complete() {
    for version in version_dirs() {
        for path in scenario_files(&version) {
            let scenario = load_scenario(&path);
            assert!(!scenario.description.trim().is_empty());
            assert!(
                !matches!(scenario.provenance.kind, FixtureProvenanceKind::Captured),
                "{} must not claim unverified capture provenance",
                scenario.scenario
            );
            assert!(
                !scenario.expected_driver_events.events.is_empty(),
                "{} has no typed event expectations",
                scenario.scenario
            );
            let (events, effects, _) = replay_contract(&scenario);
            let kinds: std::collections::BTreeSet<String> = events
                .iter()
                .map(|e| {
                    serde_json::to_value(e).unwrap()["type"]
                        .as_str()
                        .unwrap()
                        .to_string()
                })
                .collect();
            for capability in &scenario.expected_driver_events.capabilities {
                let observed = match capability.as_str() {
                    "streaming" => kinds.contains("assistantDelta"),
                    "queue" => {
                        kinds.contains("queueUpdated") || kinds.contains("queuedMessageStarted")
                    }
                    "interrogative" => kinds.contains("hostUiRequest"),
                    "reconnect_reseed" => effects.iter().any(|e| e.kind == "reseed"),
                    "abort" => kinds.contains("assistantDelta"),
                    other => panic!("{}: unknown capability claim {other}", scenario.scenario),
                };
                assert!(
                    observed,
                    "{}: capability {capability} was not observed in executable replay",
                    scenario.scenario
                );
            }
        }
    }
}

#[test]
fn corpus_expected_driver_contracts_match() {
    for version in version_dirs() {
        for path in scenario_files(&version) {
            assert_contract(&load_scenario(&path));
        }
    }
}

#[test]
fn corpus_final_state_invariants_match() {
    for version in version_dirs() {
        for path in scenario_files(&version) {
            let scenario = load_scenario(&path);
            let (_, _, acc) = replay_contract(&scenario);
            assert_eq!(
                usize::from(acc.block_kind.is_some()),
                scenario
                    .expected_driver_events
                    .final_session
                    .open_block_count,
                "{} leaves an unexpected open block",
                scenario.scenario
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Loads EVERY scenario in every version dir, asserts each `sse[]` deserializes
/// into `Vec<SseEnvelope>` (the correctness bar — every seed event must parse
/// into the real enum), and that canonicalization is deterministic (running it
/// twice yields identical output — replay determinism).
#[test]
fn corpus_loads_and_canonicalizes() {
    let versions = version_dirs();
    assert!(
        !versions.is_empty(),
        "no version dirs under {}",
        corpus_dir().display()
    );

    for version in &versions {
        let files = scenario_files(version);
        assert!(
            !files.is_empty(),
            "no scenario .json files in version {}",
            version
        );

        for path in &files {
            let mut scenario = load_scenario(path);

            // --- The correctness bar: every sse[] event parses into the real enum.
            let sse_json = serde_json::to_value(&scenario.sse).unwrap();
            let envelopes: Vec<SseEnvelope> =
                serde_json::from_value(sse_json).unwrap_or_else(|e| {
                    panic!(
                        "{}: sse[] failed to deserialize into Vec<SseEnvelope>: {}",
                        path.file_name().unwrap().to_string_lossy(),
                        e
                    )
                });
            assert!(
                !envelopes.is_empty(),
                "{}: sse[] is empty",
                path.file_name().unwrap().to_string_lossy()
            );

            // --- Canonicalization is idempotent: run twice, outputs must match.
            canonicalize_scenario(&mut scenario);
            let once = serde_json::to_string_pretty(&scenario).unwrap();

            let mut scenario2 = load_scenario(path);
            canonicalize_scenario(&mut scenario2);
            canonicalize_scenario(&mut scenario2); // second pass
            let twice = serde_json::to_string_pretty(&scenario2).unwrap();

            assert_eq!(
                once,
                twice,
                "{}: canonicalization is not idempotent",
                path.file_name().unwrap().to_string_lossy()
            );
        }
    }
}

/// Asserts each scenario file has the required sections (scenario, version,
/// canonicalization, http, sse) and non-empty sse. Catches a malformed seed
/// fixture before it silently passes the deserialize bar.
#[test]
fn capture_corpus_writes_required_sections() {
    let versions = version_dirs();
    assert!(!versions.is_empty());

    for version in &versions {
        for path in scenario_files(version) {
            let scenario = load_scenario(&path);
            let name = path
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("?")
                .to_string();

            // Required top-level sections present and non-empty where applicable.
            assert!(!scenario.scenario.is_empty(), "{name}: scenario empty");
            assert!(
                scenario.scenario == name,
                "{name}: scenario field ({}) != filename",
                scenario.scenario
            );
            assert!(!scenario.version.is_empty(), "{name}: version empty");
            assert!(
                !scenario.canonicalization.session_id.is_empty(),
                "{name}: canonicalization.session_id empty"
            );
            assert!(
                !scenario.canonicalization.prompt_ids.is_empty(),
                "{name}: canonicalization.prompt_ids empty"
            );
            assert!(
                !scenario.canonicalization.timestamps.is_empty(),
                "{name}: canonicalization.timestamps empty"
            );
            assert!(!scenario.http.is_empty(), "{name}: http[] empty");
            assert!(!scenario.sse.is_empty(), "{name}: sse[] empty");

            match scenario.provenance.kind {
                FixtureProvenanceKind::Captured => {
                    assert_eq!(
                        scenario.provenance.daemon_version.as_deref(),
                        Some(scenario.version.as_str()),
                        "{name}: captured fixture must name its daemon version"
                    );
                    assert!(
                        scenario
                            .provenance
                            .capture_method
                            .as_deref()
                            .is_some_and(|method| !method.trim().is_empty()),
                        "{name}: captured fixture must name its capture method"
                    );
                }
                FixtureProvenanceKind::SyntheticPublicSchema
                | FixtureProvenanceKind::SyntheticPantokenRegression => {
                    assert!(
                        scenario.provenance.capture_method.is_none(),
                        "{name}: synthetic fixture must not claim a capture method"
                    );
                }
            }
        }
    }
}

// ─── Canonicalization regression tests (review C1/C3) ─────────────────────────
//
// The idempotency test above proves a 2nd canonicalize pass is a no-op, but it
// can't see a 1st-pass bug where a repeated raw prompt id got a fresh placeholder
// each time (the corpus would just stabilize at the *wrong* mapping). These pin
// the two correctness invariants the canonicalizer must hold: dedupe, and
// key-driven-only mapping (no UUID-shape guessing).

/// A reusable raw prompt id (UUID-shaped, as the daemon emits).
const RAW_PROMPT: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
/// A different UUID-shaped value that is NOT a prompt id (a call_id / item_id).
const RAW_CALL_ID: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

fn empty_contract() -> support::corpus::DriverContractExpectations {
    support::corpus::DriverContractExpectations {
        capabilities: vec![],
        events: vec![],
        effects: vec![],
        final_session: FinalSessionInvariants {
            mapped_event_count: 0,
            assistant_delta_count: 0,
            open_block_count: 0,
            tool_input_buffer_empty: true,
            turn_error_present: false,
        },
        required_requests: vec![],
        forbidden_requests: vec![],
    }
}

fn synthetic_provenance() -> FixtureProvenance {
    FixtureProvenance {
        kind: FixtureProvenanceKind::SyntheticPantokenRegression,
        daemon_version: None,
        capture_method: None,
    }
}

#[test]
fn canon_prompt_dedupes_repeated_uuid_to_one_placeholder() {
    // The same raw prompt id appears 3×: in an HTTP body (PromptAccepted) and in
    // two SSE events. All MUST collapse to a single PROMPT_0, and the manifest must
    // record exactly one entry (review C1: the old code allocated PROMPT_0/1/2).
    let mut scenario = ScenarioFile {
        scenario: "dedupe-probe".to_string(),
        version: "0.5.8".to_string(),
        provenance: synthetic_provenance(),
        description: "synthetic".to_string(),
        canonicalization: CanonicalizationManifest {
            session_id: "SESSION".to_string(),
            prompt_ids: std::collections::BTreeMap::new(),
            timestamps: "monotonic-from-T0".to_string(),
        },
        http: vec![HttpEntry {
            method: "POST".to_string(),
            path: "/prompt".to_string(),
            request_body: None,
            status: 202,
            response_body: Some(serde_json::json!({
                "prompt_id": RAW_PROMPT,
                "session_id": "real-session-uuid",
            })),
        }],
        sse: vec![
            SseFrame {
                seq: Some(0),
                emitted_at: "2026-07-06T10:00:00.000Z".to_string(),
                session_id: "real-session-uuid".to_string(),
                event: serde_json::json!({ "type": "message_start", "prompt_id": RAW_PROMPT }),
            },
            SseFrame {
                seq: Some(1),
                emitted_at: "2026-07-06T10:00:01.000Z".to_string(),
                session_id: "real-session-uuid".to_string(),
                event: serde_json::json!({ "type": "message_complete", "prompt_id": RAW_PROMPT }),
            },
        ],
        expected_driver_events: empty_contract(),
    };
    canonicalize_scenario(&mut scenario);

    // Every prompt_id occurrence → "PROMPT_0".
    let http_pid = scenario.http[0]
        .response_body
        .as_ref()
        .unwrap()
        .get("prompt_id")
        .unwrap()
        .as_str()
        .unwrap();
    assert_eq!(http_pid, "PROMPT_0");
    for frame in &scenario.sse {
        assert_eq!(
            frame.event.get("prompt_id").unwrap().as_str().unwrap(),
            "PROMPT_0",
            "repeated prompt id did not dedupe"
        );
    }
    // Manifest records exactly one prompt placeholder.
    assert_eq!(scenario.canonicalization.prompt_ids.len(), 1);
    assert_eq!(
        scenario
            .canonicalization
            .prompt_ids
            .get(RAW_PROMPT)
            .unwrap(),
        "PROMPT_0"
    );
}

#[test]
fn canon_leaves_uuid_shaped_non_prompt_ids_untouched() {
    // A UUID-shaped value under a non-prompt key (call_id, item_id) must NOT be
    // remapped to a PROMPT_N placeholder (review C3: the old shape-based arm
    // corrupted it and inflated the prompt counter).
    let mut scenario = ScenarioFile {
        scenario: "non-prompt-probe".to_string(),
        version: "0.5.8".to_string(),
        provenance: synthetic_provenance(),
        description: "synthetic".to_string(),
        canonicalization: CanonicalizationManifest {
            session_id: "SESSION".to_string(),
            prompt_ids: std::collections::BTreeMap::new(),
            timestamps: "monotonic-from-T0".to_string(),
        },
        http: vec![],
        sse: vec![SseFrame {
            seq: Some(0),
            emitted_at: "2026-07-06T10:00:00.000Z".to_string(),
            session_id: "real-session-uuid".to_string(),
            event: serde_json::json!({
                "type": "tool_started",
                "prompt_id": RAW_PROMPT,
                "call_id": RAW_CALL_ID,
                "tool_input": { "item_ids": [RAW_CALL_ID] },
            }),
        }],
        expected_driver_events: empty_contract(),
    };
    canonicalize_scenario(&mut scenario);

    // prompt_id mapped; call_id + item_ids[] left as the raw UUID.
    let ev = &scenario.sse[0].event;
    assert_eq!(ev.get("prompt_id").unwrap().as_str().unwrap(), "PROMPT_0");
    assert_eq!(
        ev.get("call_id").unwrap().as_str().unwrap(),
        RAW_CALL_ID,
        "UUID-shaped call_id was wrongly remapped"
    );
    let item_ids = ev
        .get("tool_input")
        .unwrap()
        .get("item_ids")
        .unwrap()
        .as_array()
        .unwrap();
    assert_eq!(item_ids[0].as_str().unwrap(), RAW_CALL_ID);
    // Only ONE prompt placeholder was allocated (for RAW_PROMPT), not two.
    assert_eq!(scenario.canonicalization.prompt_ids.len(), 1);
}

#[test]
fn canon_maps_plural_prompt_id_arrays() {
    // Plural `*_prompt_ids` arrays (e.g. `admission_prompt_ids` on
    // pending_turn_input_drained) must have EACH string element mapped to a
    // placeholder. A real capture exposed the regression: recursing into the array
    // dropped the key context, so the UUIDs leaked raw while the singular field for
    // the SAME id showed PROMPT_N — an inconsistent, non-deterministic corpus.
    const RAW_PROMPT_2: &str = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    let mut scenario = ScenarioFile {
        scenario: "plural-probe".to_string(),
        version: "0.5.8".to_string(),
        provenance: synthetic_provenance(),
        description: "synthetic".to_string(),
        canonicalization: CanonicalizationManifest {
            session_id: "SESSION".to_string(),
            prompt_ids: std::collections::BTreeMap::new(),
            timestamps: "monotonic-from-T0".to_string(),
        },
        http: vec![],
        sse: vec![SseFrame {
            seq: Some(0),
            emitted_at: "2026-07-06T10:00:00.000Z".to_string(),
            session_id: "real-session-uuid".to_string(),
            event: serde_json::json!({
                "type": "pending_turn_input_drained",
                // Singular field registers RAW_PROMPT; the plural array must REUSE that
                // placeholder for the same id and allocate a fresh one for RAW_PROMPT_2.
                "admission_prompt_id": RAW_PROMPT,
                "admission_prompt_ids": [RAW_PROMPT, RAW_PROMPT_2],
                // A UUID-shaped NON-prompt array stays raw (item_ids ≠ *_prompt_ids).
                "item_ids": [RAW_CALL_ID],
            }),
        }],
        expected_driver_events: empty_contract(),
    };
    canonicalize_scenario(&mut scenario);

    let ev = &scenario.sse[0].event;
    assert_eq!(
        ev.get("admission_prompt_id").unwrap().as_str().unwrap(),
        "PROMPT_0"
    );
    let arr = ev.get("admission_prompt_ids").unwrap().as_array().unwrap();
    assert_eq!(
        arr[0].as_str().unwrap(),
        "PROMPT_0",
        "plural array element leaked raw (the pre-fix regression)"
    );
    assert_eq!(
        arr[1].as_str().unwrap(),
        "PROMPT_1",
        "second plural array element not mapped"
    );
    // item_ids (non-prompt) left raw.
    let items = ev.get("item_ids").unwrap().as_array().unwrap();
    assert_eq!(items[0].as_str().unwrap(), RAW_CALL_ID);
    // Exactly two prompt placeholders allocated (RAW_PROMPT, RAW_PROMPT_2).
    assert_eq!(scenario.canonicalization.prompt_ids.len(), 2);
}

#[test]
fn canon_rewrites_inner_emitted_at() {
    let mut state = CanonState::default();
    let mut frame = SseFrame {
        seq: Some(3),
        emitted_at: "2026-07-05T22:52:08Z".to_string(),
        session_id: "real-session-uuid".to_string(),
        event: serde_json::json!({
            "type": "system_reminder",
            "emitted_at": "2026-07-05T22:52:08Z",
        }),
    };

    canonicalize_frame(&mut frame, 3, &mut state);
    let first = frame.event["emitted_at"].as_str().unwrap().to_string();
    assert!(is_monotonic_epoch(&first));
    assert_eq!(first, monotonic_timestamp(3));

    canonicalize_frame(&mut frame, 3, &mut state);
    assert_eq!(frame.event["emitted_at"].as_str().unwrap(), first);
}

fn assert_state_redactions(path: &PathBuf, value: &Value) {
    let Some(http) = value.get("http").and_then(Value::as_array) else {
        panic!("{}: http[] missing or not an array", path.display());
    };
    for (idx, entry) in http.iter().enumerate() {
        if entry.get("path").and_then(Value::as_str) != Some("/state") {
            continue;
        }
        let Some(body) = entry.get("response_body") else {
            panic!(
                "{}: http[{idx}] /state missing response_body",
                path.display()
            );
        };
        assert_state_body_redactions(path, idx, body, "response_body");
    }
}

fn assert_state_body_redactions(path: &PathBuf, http_idx: usize, value: &Value, field_path: &str) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let child_path = format!("{field_path}.{key}");
                match key.as_str() {
                    "env" => assert!(
                        child.as_object().is_some_and(|obj| obj.is_empty()),
                        "{}: http[{http_idx}] {child_path} must be empty object",
                        path.display()
                    ),
                    "used_tokens" => assert_eq!(
                        child.as_i64(),
                        Some(0),
                        "{}: http[{http_idx}] {child_path} must be 0",
                        path.display()
                    ),
                    "most_recent_assistant_text" => assert_eq!(
                        child.as_str(),
                        Some(""),
                        "{}: http[{http_idx}] {child_path} must be empty string",
                        path.display()
                    ),
                    "project_cwd" => assert_eq!(
                        child.as_str(),
                        Some("/PROJECT"),
                        "{}: http[{http_idx}] {child_path} must be /PROJECT",
                        path.display()
                    ),
                    // source_control keeps its shape + `kind`, but every
                    // run-varying leaf must be redacted to a fixed placeholder
                    // (mirrors the redactor in canonicalize_value).
                    "source_control" => {
                        if let Value::Object(sc) = child {
                            if let Some(label) = sc.get("label") {
                                assert_eq!(
                                    label.as_str(),
                                    Some("BRANCH"),
                                    "{}: http[{http_idx}] {child_path}.label must be redacted to BRANCH",
                                    path.display()
                                );
                            }
                            if let Some(dirty) = sc.get("dirty") {
                                assert_eq!(
                                    dirty.as_bool(),
                                    Some(false),
                                    "{}: http[{http_idx}] {child_path}.dirty must be redacted to false",
                                    path.display()
                                );
                            }
                            for leaf in ["commit", "sha", "revision", "head", "upstream"] {
                                if let Some(v) = sc.get(leaf) {
                                    if v.is_string() {
                                        assert_eq!(
                                            v.as_str(),
                                            Some("COMMIT"),
                                            "{}: http[{http_idx}] {child_path}.{leaf} must be redacted to COMMIT",
                                            path.display()
                                        );
                                    }
                                }
                            }
                        }
                    }
                    _ => assert_state_body_redactions(path, http_idx, child, &child_path),
                }
            }
        }
        Value::Array(arr) => {
            for (idx, child) in arr.iter().enumerate() {
                assert_state_body_redactions(
                    path,
                    http_idx,
                    child,
                    &format!("{field_path}[{idx}]"),
                );
            }
        }
        _ => {}
    }
}

#[test]
fn corpus_has_no_machine_specific_data() {
    for version in version_dirs() {
        for path in scenario_files(&version) {
            let text = fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
            // Absolute home-dir prefixes for both capture platforms (macOS
            // `/Users/`, Linux `/home/`) are the machine-specific leak vector.
            for needle in ["/Users/", "/home/"] {
                assert!(
                    !text.contains(needle),
                    "{}: raw file contains {needle}",
                    path.display()
                );
            }
            let value: Value = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e));
            assert_state_redactions(&path, &value);
        }
    }
}

#[test]
fn canon_matches_ts_golden() {
    let dir: PathBuf = std::env::var("PANTOKEN_CANON_PARITY_DIR")
        .map(PathBuf::from)
        .or_else(|_| {
            // Test runner env: PANTOKEN_CANON_PARITY_FILES contains space-separated file paths.
            // Derive the canon-parity directory from the first file's parent.
            std::env::var("PANTOKEN_CANON_PARITY_FILES")
                .ok()
                .and_then(|files| {
                    files
                        .split_whitespace()
                        .next()
                        .and_then(|first| PathBuf::from(first).parent().map(|p| p.to_path_buf()))
                })
                .ok_or(())
        })
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/canon-parity")
        });
    let non_canonical_path = dir.join("non-canonical.json");
    let golden_path = dir.join("ts-canonical.golden.json");

    let mut canonicalized = load_scenario(&non_canonical_path);
    canonicalize_scenario(&mut canonicalized);
    let golden = load_scenario(&golden_path);

    assert_eq!(
        serde_json::to_string_pretty(&canonicalized).unwrap(),
        serde_json::to_string_pretty(&golden).unwrap(),
        "Rust canonicalization drifted from TS golden"
    );
}
