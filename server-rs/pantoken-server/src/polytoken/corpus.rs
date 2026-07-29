//! Golden daemon corpus loader — the shared parser used by the canonicalization
//! tests (`corpus.rs`) and the fake-daemon integration harness.
//!
//! This is the loader half of `tests/corpus.rs`, extracted so the harness can
//! load a `ScenarioFile` without duplicating parse logic. The canonicalization
//! machinery (the value/frame/http rewriters + the idempotency tests) stays in
//! `corpus.rs`; only the structs + load/enum helpers live here.
//!
//! See `server-rs/tests/corpus/0.5.8/README.md` for the file format.
//
// `load_named`/`sole_version`/`envelope` are consumed by the fake-daemon harness
// (`live_path.rs`), which lands in a later step of this same plan. Until then
// they're unused from `corpus.rs`'s view — silence rather than delete.
#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use pantoken_daemon_types::SseEnvelope;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Resolve the corpus root: `<crate>/../tests/corpus` (i.e. `server-rs/tests/corpus`).
/// Checks PANTOKEN_CORPUS_DIR at runtime (test runner env), falls back to
/// env!("CARGO_MANIFEST_DIR") (Cargo).
pub fn corpus_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("PANTOKEN_CORPUS_DIR") {
        return std::path::PathBuf::from(dir);
    }
    // Test runner env: PANTOKEN_CORPUS_FILES contains space-separated file paths.
    // Derive the corpus root from the first file's path (up two parents).
    if let Ok(files) = std::env::var("PANTOKEN_CORPUS_FILES") {
        if let Some(first) = files.split_whitespace().next() {
            let path = std::path::PathBuf::from(first);
            // Files are at <corpus>/<version>/<file>.json; corpus root is two parents up.
            if let Some(version_dir) = path.parent() {
                if let Some(corpus_root) = version_dir.parent() {
                    return corpus_root.to_path_buf();
                }
            }
        }
    }
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/corpus"))
}

// ---------------------------------------------------------------------------
// Scenario file structs (mirror the JSON shape documented in the README)
// ---------------------------------------------------------------------------

/// The `canonicalization` manifest block of a scenario file.
///
/// `prompt_ids` is a `BTreeMap` (not `HashMap`) so serialization is deterministic
/// — the idempotency test compares pretty-printed JSON, and a `HashMap`'s
/// arbitrary iteration order would make two identical maps serialize differently.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanonicalizationManifest {
    pub session_id: String,
    pub prompt_ids: std::collections::BTreeMap<String, String>,
    pub timestamps: String,
}

/// One recorded HTTP request/response pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpEntry {
    pub method: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_body: Option<Value>,
    pub status: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_body: Option<Value>,
}

/// One SSE frame — the wire shape of a daemon `/events` `data:` payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SseFrame {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    pub emitted_at: String,
    pub session_id: String,
    pub event: Value,
}

impl SseFrame {
    /// Deserialize the frame as the real `SseEnvelope` (the frame shape
    /// `{seq, emitted_at, session_id, event}` IS the envelope shape). The loader
    /// test enforces every frame deserializes, so a daemon event-shape drift
    /// fails loud.
    pub fn envelope(&self) -> Result<SseEnvelope, serde_json::Error> {
        // Round-trip through a Value: the frame fields already match the
        // envelope's (same names), and `event` is a Value that serde will
        // re-parse into the tagged `DaemonEvent` enum.
        let value = serde_json::to_value(self).expect("SseFrame serializable");
        serde_json::from_value::<SseEnvelope>(value)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FixtureProvenanceKind {
    Captured,
    SyntheticPublicSchema,
    SyntheticPantokenRegression,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixtureProvenance {
    pub kind: FixtureProvenanceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_method: Option<String>,
}

/// A full scenario file.
/// Stable Pantoken-boundary expectation.  These fields intentionally avoid
/// timestamps, generated ids, and model prose.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverEventExpectation {
    pub kind: String,
    pub count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub essential: Option<std::collections::BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DriverEffectExpectation {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinalSessionInvariants {
    pub mapped_event_count: usize,
    pub assistant_delta_count: usize,
    pub open_block_count: usize,
    pub tool_input_buffer_empty: bool,
    pub turn_error_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriverContractExpectations {
    pub capabilities: Vec<String>,
    pub events: Vec<DriverEventExpectation>,
    pub effects: Vec<DriverEffectExpectation>,
    pub final_session: FinalSessionInvariants,
    pub required_requests: Vec<String>,
    pub forbidden_requests: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioFile {
    pub scenario: String,
    pub version: String,
    pub provenance: FixtureProvenance,
    #[allow(dead_code)]
    pub description: String,
    pub canonicalization: CanonicalizationManifest,
    pub http: Vec<HttpEntry>,
    pub sse: Vec<SseFrame>,
    pub expected_driver_events: DriverContractExpectations,
}

// ---------------------------------------------------------------------------
// Corpus loading helpers
// ---------------------------------------------------------------------------

/// Enumerate every `.json` scenario file under `<corpus>/<version>/`, sorted for
/// deterministic test ordering. Fails loud if the version dir is missing.
pub fn scenario_files(version: &str) -> Vec<PathBuf> {
    let dir: PathBuf = corpus_dir().join(version);
    assert!(
        dir.exists(),
        "corpus version dir missing: {}",
        dir.display()
    );
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read corpus dir {}: {}", dir.display(), e))
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
}

/// Load + parse one scenario file. Fails loud on read/parse errors.
pub fn load_scenario(path: &PathBuf) -> ScenarioFile {
    let text =
        fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    serde_json::from_str::<ScenarioFile>(&text)
        .unwrap_or_else(|e| panic!("parse {}: {}", path.display(), e))
}

/// Load a scenario by name from the given version dir.
pub fn load_named(version: &str, name: &str) -> ScenarioFile {
    let path = corpus_dir().join(version).join(format!("{name}.json"));
    assert!(path.exists(), "scenario missing: {}", path.display());
    load_scenario(&path)
}

/// The version dir(s) to test. New seed corpora ship under a versioned subdir;
/// this picks up every subdir under the corpus root.
pub fn version_dirs() -> Vec<String> {
    let root = corpus_dir();
    assert!(root.exists(), "corpus root missing: {}", root.display());
    let mut dirs: Vec<String> = fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read corpus root {}: {}", root.display(), e))
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
        })
        .collect();
    dirs.sort();
    dirs
}

/// Select the active corpus explicitly. Tests and fake mode may override with
/// `PANTOKEN_CORPUS_VERSION`; otherwise use the public codegen target version.
/// Historical version directories remain loadable through `version_dirs()`.
pub fn active_version() -> String {
    let selected = std::env::var("PANTOKEN_CORPUS_VERSION")
        .unwrap_or_else(|_| pantoken_daemon_types::POLYTOKEN_DAEMON_TARGET_VERSION.to_string());
    let dirs = version_dirs();
    assert!(
        dirs.contains(&selected),
        "active corpus version {selected:?} missing; available versions: {dirs:?}"
    );
    selected
}

#[deprecated(note = "use active_version; historical corpus versions may coexist")]
pub fn sole_version() -> String {
    active_version()
}
