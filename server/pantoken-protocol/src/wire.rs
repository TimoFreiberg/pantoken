//! WS protocol envelope types — Rust port of `protocol/src/wire.ts`.
//!
//! `ClientMessage` and `ServerMessage` are the two directions of the pantoken
//! WebSocket protocol. Both use `type` as the serde tag with camelCase
//! variant names, matching the TS wire format exactly.

use serde::{Deserialize, Serialize};

use crate::session_driver::{
    AtRefs, BackgroundJob, CommandInfo, FileInfo, HostUiResponse, ImageContent,
    ModelCatalogDiagnostic, ModelDefaults, ModelOption, PermissionMonitorMode, SessionDriverEvent,
    SessionId, SessionListEntry,
};

// Must equal PROTOCOL_VERSION in protocol/src/wire.ts. 3→4 adds request correlation
// to directory-picker queries so remote replies cannot replace newer results.
// 4→5 adds listBranches/branchList for the worktree branch selector.
// 5→6 removes worktree support (worktree/baseBranch fields, listBranches/branchList/
// cleanupWorktree/worktreeRetained messages, WorktreeInfo).
pub const PROTOCOL_VERSION: u32 = 6;

// ── PantokenSettings (server-side persisted settings) ──────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PantokenSettings {
    #[serde(rename = "loginShell")]
    pub login_shell: Option<String>,
    #[serde(rename = "backgroundModel")]
    pub background_model: Option<String>,
    #[serde(rename = "enabledExtensions", default)]
    pub enabled_extensions: Option<Vec<String>>,
}

// ── LoginEnvStatus ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginEnvStatus {
    #[serde(rename = "activeShell")]
    pub active_shell: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
}

// ── Trust ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustRequestOption {
    pub label: String,
    pub trusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub cwd: String,
    pub title: String,
    pub options: Vec<TrustRequestOption>,
}

// ── DirListing / PathStat (defined in session_driver, re-exported) ─────
// These are in session_driver.rs already. wire.ts defines them locally but
// they're the same types — re-export from session_driver for the ServerMessage
// variants that flatten them.
pub use crate::session_driver::{DirListing, PathStat};

// ── SessionAttention ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionAttention {
    #[serde(rename = "sessionId")]
    pub session_id: SessionId,
    pub phase: SessionAttentionPhase,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub activity: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "pendingCount"
    )]
    pub pending_count: Option<i64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "pendingTitle"
    )]
    pub pending_title: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionAttentionPhase {
    Running,
    Waiting,
    Failed,
    Done,
}

// ── ResumeToken ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResumeToken {
    #[serde(rename = "sessionId")]
    pub session_id: SessionId,
    pub epoch: u64,
    pub seq: u64,
}

// ── ServerMessage ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(
    clippy::large_enum_variant,
    reason = "wire enum; big variant is the snapshot"
)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage {
    Hello {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "serverId")]
        server_id: String,
        #[serde(rename = "serverLabel")]
        #[serde(default)]
        server_label: String,
        #[serde(rename = "dataDir")]
        data_dir: String,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "buildSha")]
        build_sha: Option<String>,
    },
    /// Heartbeat reply to a client `Ping` — transport-level only (never folded or
    /// journaled), the same shape of message as `Hello`. The client's ws layer already
    /// treats ANY inbound frame as proof of liveness, so `Pong` carries no fields of its
    /// own; it exists purely to give a sent ping something to solicit.
    Pong,
    Seed {
        #[serde(rename = "sessionId")]
        session_id: Option<SessionId>,
        epoch: u64,
        seq: u64,
        events: Vec<SessionDriverEvent>,
    },
    Event {
        event: SessionDriverEvent,
        epoch: u64,
        seq: u64,
    },
    SessionList {
        sessions: Vec<SessionListEntry>,
        #[serde(rename = "activeSessionId")]
        active_session_id: Option<SessionId>,
        #[serde(rename = "defaultNewSessionCwd")]
        default_new_session_cwd: String,
    },
    SessionStatus {
        #[serde(rename = "runningIds")]
        running_ids: Vec<SessionId>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "initializingIds"
        )]
        initializing_ids: Option<Vec<SessionId>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        attention: Option<Vec<SessionAttention>>,
    },
    ModelList {
        models: Vec<ModelOption>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        diagnostic: Option<ModelCatalogDiagnostic>,
    },
    CommandList {
        commands: Vec<CommandInfo>,
    },
    FacetList {
        facets: Vec<String>,
    },
    JobsList {
        jobs: Vec<BackgroundJob>,
    },
    FileIndex {
        files: Vec<FileInfo>,
        #[serde(default)]
        truncated: bool,
    },
    /// `include_ignored` echoes the request's flag (Shift+Tab picker toggle) — a
    /// second staleness guard alongside `query`: a toggled request must not be
    /// satisfied by a stale untoggled response (or vice versa) racing back after
    /// the toggle flipped.
    FileList {
        query: String,
        files: Vec<FileInfo>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "includeIgnored"
        )]
        include_ignored: Option<bool>,
    },
    /// Skills + subagents available for composer `@`-reference autocomplete.
    /// Server-authoritative like `FileIndex`; pushed on connect and re-pushed
    /// on session switch (session/cwd-scoped). See `AtRefs`.
    AtRefs {
        #[serde(flatten)]
        refs: AtRefs,
    },
    DirListing {
        #[serde(flatten)]
        listing: DirListing,
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    PathStat {
        #[serde(flatten)]
        stat: PathStat,
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    ModelDefaults {
        defaults: ModelDefaults,
    },
    PantokenSettings {
        settings: PantokenSettings,
        env: LoginEnvStatus,
        #[serde(rename = "pendingRestart")]
        pending_restart: bool,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "backgroundModelWarning"
        )]
        background_model_warning: Option<String>,
    },
    TrustRequest {
        #[serde(flatten)]
        request: TrustRequest,
    },
    TrustResolved {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    UpdateStatus {
        available: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        sha: Option<String>,
        applying: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        status: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reason: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "desktopStale"
        )]
        desktop_stale: Option<bool>,
    },
    EditorPrefill {
        text: String,
    },
    PromptResult {
        #[serde(rename = "promptId")]
        prompt_id: String,
        accepted: bool,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
    },
    QueueRestored {
        steering: Vec<String>,
        #[serde(rename = "followUp")]
        follow_up: Vec<String>,
    },
    /// Correlated outcome for one stop attempt. `accepted` means the daemon accepted
    /// the request; a terminal driver event still settles the transcript.
    AbortResult {
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "requestId")]
        request_id: Option<String>,
        accepted: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
    },
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        kind: Option<String>,
    },
}

// ── ClientMessage ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Hello {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        auth: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        resume: Option<ResumeToken>,
    },
    Prompt {
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "promptId")]
        prompt_id: Option<String>,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        images: Option<Vec<ImageContent>>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "deliverAs")]
        deliver_as: Option<DeliveryMode>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    Abort {
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "requestId")]
        request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    RestoreQueue {
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    RespondUi {
        response: HostUiResponse,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    /// The data-driven envelope for fire-and-forget session actions that share
    /// one shape (a daemon POST; updated state arrives via later events).
    /// Adding an action = one `SessionAction` variant + one arm per driver.
    SessionAction {
        action: SessionAction,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    /// Permanently reap an empty, default-settings session by its stable path.
    DestroySession {
        path: String,
    },
    SetLoginShell {
        path: Option<String>,
    },
    SetBackgroundModel {
        spec: Option<String>,
    },
    OpenSession {
        path: String,
    },
    ReloadSession {
        path: String,
    },
    Branch {
        #[serde(rename = "entryId")]
        entry_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        summarize: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    NewSession {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        cwd: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        model: Option<NewSessionModel>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        thinking: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        facet: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "permissionMonitor"
        )]
        permission_monitor: Option<PermissionMonitorMode>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "promptId")]
        prompt_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        images: Option<Vec<ImageContent>>,
    },
    ListSessions,
    SetArchived {
        path: String,
        archived: bool,
    },
    RenameSession {
        path: String,
        name: String,
    },
    /// Detach from a session: release Pantoken's TUI attachment lease so an
    /// external client (terminal polytoken CLI) can take over. The daemon
    /// stays alive; the session reappears as idle in the sidebar. Only
    /// meaningful for the polytoken driver; the mock/default is a no-op.
    DetachSession {
        path: String,
    },
    ListCommands,
    ListFacets,
    FetchJobs,
    DeleteTodo {
        id: i64,
    },
    /// `include_ignored`: the picker's Shift+Tab toggle — when true, hidden
    /// dotfiles and gitignored entries are included too (project AND external
    /// browsing), bypassing the normal ignore-file filtering. Absent/false is
    /// the default (filtered) behavior.
    QueryFiles {
        query: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        cwd: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "includeIgnored"
        )]
        include_ignored: Option<bool>,
    },
    QueryDir {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        path: Option<String>,
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    StatPath {
        path: String,
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    TrustResponse {
        #[serde(rename = "requestId")]
        request_id: String,
        choice: Option<i64>,
    },
    ApplyUpdate,
    ForceUpdate,
    RequestSeed {
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "sessionId")]
        session_id: Option<SessionId>,
    },
    Mock {
        script: String,
    },
    OpenDataDir,
    /// Heartbeat probe: sent on an interval while connected (and once immediately on a
    /// wake — tab foregrounded, bfcache restore, network back online) to catch a
    /// half-open socket that TCP itself may never surface (phone slept, NAT dropped the
    /// stream, no FIN/RST ever arrives). The hub replies with `Pong`; the client
    /// actually treats ANY inbound frame as liveness, so this mostly exists to solicit
    /// one on a schedule.
    Ping,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryMode {
    Steer,
    FollowUp,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum McpAction {
    Enable,
    Disable,
    Disconnect,
    Reconnect,
}

/// The fire-and-forget pass-through actions carried by
/// `ClientMessage::SessionAction`. They share one lifecycle: POST to the
/// daemon, no direct reply — the effect arrives as later driver events
/// (snapshots, notifications, usage updates). Daemon endpoints:
/// POST /adventurous-handoff (toggle), /notifications/autodrain, /compact,
/// /clear (context + shell env), /mcp/{server}/{action}, /model, /thinking,
/// /facet, /permission-monitor, /reset-shell, /reload, /goal (set/pause/resume/clear),
/// /title.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionAction {
    ToggleAdventurousHandoff,
    SetNotificationAutodrain {
        enabled: bool,
    },
    Compact,
    ClearContext,
    SetMcpServer {
        #[serde(rename = "serverName")]
        server_name: String,
        action: McpAction,
    },
    SetModel {
        #[serde(rename = "modelId")]
        model_id: String,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "thinkingLevel"
        )]
        thinking_level: Option<String>,
    },
    SetThinking {
        level: String,
    },
    SetFacet {
        facet: String,
    },
    SetPermissionMonitor {
        mode: PermissionMonitorMode,
    },
    /// `POST /reset-shell` — restore the shell env to the startup baseline.
    ResetShell,
    /// `POST /reload` — re-read config, skills, facets, etc.
    DaemonReload,
    /// `POST /goal` — create or replace the current goal.
    GoalSet {
        summary: String,
    },
    /// `POST /goal/pause` — pause the active goal.
    GoalPause,
    /// `POST /goal/resume` — resume a paused goal.
    GoalResume,
    /// `POST /goal/clear` — clear the current goal (idempotent).
    GoalClear,
    /// `POST /title` — set the session title.
    SetTitle {
        title: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewSessionModel {
    #[serde(rename = "modelId")]
    pub model_id: String,
}

// ── Parse helpers (match wire.ts parseClientMessage/parseServerMessage) ─

/// Parse a decoded JSON value at the client WebSocket ingress boundary.
///
/// The production ingress validates the effective TypeScript contract before serde:
/// optional non-null fields reject explicit `null`, while required nullable fields
/// accept it. Direct serde decoding remains intentionally permissive for non-ingress
/// callers. Unknown object fields remain tolerant for additive protocol evolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireValidationError(pub String);

impl std::fmt::Display for WireValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for WireValidationError {}

fn json_is_string(value: &serde_json::Value) -> bool {
    value.is_string()
}

fn json_is_bool(value: &serde_json::Value) -> bool {
    value.is_boolean()
}

const MAX_SAFE_WIRE_INTEGER: u64 = 9_007_199_254_740_991;

fn json_is_u64(value: &serde_json::Value) -> bool {
    value
        .as_u64()
        .is_some_and(|number| number <= MAX_SAFE_WIRE_INTEGER)
}

fn json_is_i64(value: &serde_json::Value) -> bool {
    value
        .as_i64()
        .is_some_and(|number| number.unsigned_abs() <= MAX_SAFE_WIRE_INTEGER)
}

fn json_is_nullable_string(value: &serde_json::Value) -> bool {
    value.is_null() || value.is_string()
}

fn json_require(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    predicate: fn(&serde_json::Value) -> bool,
) -> Result<(), WireValidationError> {
    match object.get(key) {
        Some(value) if predicate(value) => Ok(()),
        Some(_) => Err(WireValidationError(format!("{key} has the wrong type"))),
        None => Err(WireValidationError(format!(
            "missing required field: {key}"
        ))),
    }
}

fn json_optional(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    predicate: fn(&serde_json::Value) -> bool,
) -> Result<(), WireValidationError> {
    match object.get(key) {
        Some(value) if predicate(value) => Ok(()),
        Some(_) => Err(WireValidationError(format!("{key} has the wrong type"))),
        None => Ok(()),
    }
}

fn json_array_of(value: &serde_json::Value, predicate: fn(&serde_json::Value) -> bool) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(predicate))
}

fn json_is_image(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("type").and_then(serde_json::Value::as_str) == Some("image")
        && object.get("data").is_some_and(json_is_string)
        && object.get("mimeType").is_some_and(json_is_string)
}

fn json_is_resume(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "sessionId", json_is_string).is_ok()
        && json_require(object, "epoch", json_is_u64).is_ok()
        && json_require(object, "seq", json_is_u64).is_ok()
}

fn json_is_qna_answer(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "selectedOptionIndices", |value| {
        json_array_of(value, json_is_i64)
    })
    .is_ok()
        && json_require(object, "customText", json_is_string).is_ok()
}

fn json_is_host_ui_response(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if json_require(object, "requestId", json_is_string).is_err() {
        return false;
    }

    // Match the TypeScript union's shape precedence. An unrelated additive key
    // such as `cancelled` is ignored when `value`, `confirmed`, or `answers`
    // selects another known response shape.
    if object.contains_key("value") {
        return json_require(object, "value", json_is_string).is_ok()
            && json_optional(object, "feedback", json_is_string).is_ok();
    }
    if object.contains_key("confirmed") {
        return json_require(object, "confirmed", json_is_bool).is_ok();
    }
    if object.contains_key("answers") {
        return json_require(object, "answers", |value| {
            json_array_of(value, json_is_qna_answer)
        })
        .is_ok();
    }
    object.get("cancelled") == Some(&serde_json::Value::Bool(true))
}

fn json_is_session_action(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(kind) = object.get("kind").and_then(serde_json::Value::as_str) else {
        return false;
    };
    match kind {
        "toggleAdventurousHandoff"
        | "compact"
        | "clearContext"
        | "resetShell"
        | "daemonReload"
        | "goalPause"
        | "goalResume"
        | "goalClear" => true,
        "setNotificationAutodrain" => json_require(object, "enabled", json_is_bool).is_ok(),
        "setMcpServer" => {
            json_require(object, "serverName", json_is_string).is_ok()
                && json_require(object, "action", |value| {
                    matches!(
                        value.as_str(),
                        Some("enable" | "disable" | "disconnect" | "reconnect")
                    )
                })
                .is_ok()
        }
        "setModel" => {
            json_require(object, "modelId", json_is_string).is_ok()
                && json_optional(object, "thinkingLevel", json_is_string).is_ok()
        }
        "setThinking" => json_require(object, "level", json_is_string).is_ok(),
        "setFacet" => json_require(object, "facet", json_is_string).is_ok(),
        "setPermissionMonitor" => json_require(object, "mode", |value| {
            matches!(
                value.as_str(),
                Some("standard" | "bypass" | "bypass_plus" | "autonomous")
            )
        })
        .is_ok(),
        "goalSet" => json_require(object, "summary", json_is_string).is_ok(),
        "setTitle" => json_require(object, "title", json_is_string).is_ok(),
        _ => false,
    }
}

fn validate_client_message_shape(
    object: &serde_json::Map<String, serde_json::Value>,
    kind: &str,
) -> Result<(), WireValidationError> {
    match kind {
        "hello" => {
            json_optional(object, "auth", json_is_string)?;
            if let Some(resume) = object.get("resume") {
                if !json_is_resume(resume) {
                    return Err(WireValidationError("invalid hello.resume".into()));
                }
            }
        }
        "prompt" => {
            json_require(object, "text", json_is_string)?;
            json_optional(object, "promptId", json_is_string)?;
            json_optional(object, "images", |value| {
                json_array_of(value, json_is_image)
            })?;
            json_optional(object, "deliverAs", |value| {
                matches!(value.as_str(), Some("steer" | "followUp"))
            })?;
            json_optional(object, "sessionId", json_is_string)?;
        }
        "abort" => {
            json_optional(object, "requestId", json_is_string)?;
            json_optional(object, "sessionId", json_is_string)?;
        }
        "restoreQueue" | "requestSeed" => {
            json_optional(object, "sessionId", json_is_string)?;
        }
        "respondUi" => {
            json_require(object, "response", json_is_host_ui_response)?;
            json_optional(object, "sessionId", json_is_string)?;
        }
        "sessionAction" => {
            json_require(object, "action", json_is_session_action)?;
            json_optional(object, "sessionId", json_is_string)?;
        }
        "destroySession" | "openSession" | "reloadSession" => {
            json_require(object, "path", json_is_string)?;
        }
        "setLoginShell" => {
            json_require(object, "path", json_is_nullable_string)?;
        }
        "setBackgroundModel" => {
            json_require(object, "spec", json_is_nullable_string)?;
        }
        "branch" => {
            json_require(object, "entryId", json_is_string)?;
            json_optional(object, "summarize", json_is_bool)?;
            json_optional(object, "sessionId", json_is_string)?;
        }
        "newSession" => {
            json_optional(object, "cwd", json_is_string)?;
            json_optional(object, "model", |value| {
                value
                    .as_object()
                    .is_some_and(|model| json_require(model, "modelId", json_is_string).is_ok())
            })?;
            json_optional(object, "thinking", json_is_string)?;
            json_optional(object, "facet", json_is_string)?;
            json_optional(object, "permissionMonitor", |value| {
                matches!(
                    value.as_str(),
                    Some("standard" | "bypass" | "bypass_plus" | "autonomous")
                )
            })?;
            json_optional(object, "prompt", json_is_string)?;
            json_optional(object, "promptId", json_is_string)?;
            json_optional(object, "images", |value| {
                json_array_of(value, json_is_image)
            })?;
        }
        "listSessions" | "listCommands" | "listFacets" | "fetchJobs" | "applyUpdate"
        | "forceUpdate" | "openDataDir" | "ping" => {}
        "setArchived" => {
            json_require(object, "path", json_is_string)?;
            json_require(object, "archived", json_is_bool)?;
        }
        "renameSession" => {
            json_require(object, "path", json_is_string)?;
            json_require(object, "name", json_is_string)?;
        }
        "detachSession" => {
            json_require(object, "path", json_is_string)?;
        }
        "deleteTodo" => {
            json_require(object, "id", json_is_i64)?;
        }
        "queryFiles" => {
            json_require(object, "query", json_is_string)?;
            json_optional(object, "cwd", json_is_string)?;
            json_optional(object, "includeIgnored", json_is_bool)?;
        }
        "queryDir" => {
            json_optional(object, "path", json_is_string)?;
            json_require(object, "requestId", json_is_u64)?;
        }
        "statPath" => {
            json_require(object, "path", json_is_string)?;
            json_require(object, "requestId", json_is_u64)?;
        }
        "trustResponse" => {
            json_require(object, "requestId", json_is_string)?;
            json_require(object, "choice", |value| {
                value.is_null() || json_is_i64(value)
            })?;
        }
        "mock" => {
            json_require(object, "script", json_is_string)?;
        }
        _ => {
            return Err(WireValidationError(format!(
                "unknown client message type: {kind}"
            )));
        }
    }
    Ok(())
}

pub fn parse_client_message_value(
    value: serde_json::Value,
) -> Result<ClientMessage, WireValidationError> {
    let object = value
        .as_object()
        .ok_or_else(|| WireValidationError("client message must be an object".into()))?;
    let kind = object
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| WireValidationError("client message type must be a string".into()))?;
    validate_client_message_shape(object, kind)?;
    serde_json::from_value(value).map_err(|error| WireValidationError(error.to_string()))
}

/// Parse a raw JSON string into a ClientMessage. Returns None on parse failure
/// or if the `type` field is missing/non-string — matching the TS behavior.
pub fn parse_client_message(raw: &str) -> Option<ClientMessage> {
    let value = serde_json::from_str(raw).ok()?;
    parse_client_message_value(value).ok()
}

type JsonPredicate = fn(&serde_json::Value) -> bool;

type JsonRequiredField = (&'static str, JsonPredicate);

fn json_server_required_fields(
    object: &serde_json::Map<String, serde_json::Value>,
    fields: &[JsonRequiredField],
) -> bool {
    fields
        .iter()
        .all(|(key, predicate)| object.get(*key).is_some_and(predicate))
}

fn json_server_nullable_required(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    predicate: fn(&serde_json::Value) -> bool,
) -> bool {
    object
        .get(key)
        .is_some_and(|value| value.is_null() || predicate(value))
}

fn json_is_resolved_ref(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "kind", json_is_string).is_ok()
        && json_require(object, "name", json_is_string).is_ok()
        && json_optional(object, "fileKind", json_is_string).is_ok()
}

fn json_is_queued_message(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "id", json_is_string).is_ok()
        && json_require(object, "mode", |value| {
            matches!(value.as_str(), Some("steer" | "followUp"))
        })
        .is_ok()
        && json_require(object, "text", json_is_string).is_ok()
        && json_require(object, "createdAt", json_is_string).is_ok()
        && json_require(object, "updatedAt", json_is_string).is_ok()
        && json_optional(object, "references", |value| {
            json_array_of(value, json_is_resolved_ref)
        })
        .is_ok()
}

fn json_is_session_config(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_optional(object, "modelId", json_is_string).is_ok()
        && json_optional(object, "thinkingLevel", json_is_string).is_ok()
        && json_optional(object, "availableThinkingLevels", |value| {
            json_array_of(value, json_is_string)
        })
        .is_ok()
}

fn json_is_usage(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "tokens", |value| {
        value.is_null() || json_is_i64(value)
    })
    .is_ok()
        && json_require(object, "contextWindow", json_is_i64).is_ok()
        && json_require(object, "percent", |value| {
            value.is_null() || value.is_number()
        })
        .is_ok()
}

fn json_is_mcp_info(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "serverName", json_is_string).is_ok()
        && json_require(object, "status", |value| {
            matches!(
                value.as_str(),
                Some("connected" | "disconnected" | "reconnecting" | "disabled")
            )
        })
        .is_ok()
        && json_require(object, "toolCount", |value| value.is_number()).is_ok()
}

fn json_is_diagnostic(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "kind", |value| {
        matches!(
            value.as_str(),
            Some("couldNotBeParsed" | "emptyOutput" | "noResponse")
        )
    })
    .is_ok()
        && json_require(object, "message", json_is_string).is_ok()
}

fn json_is_model_option(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "modelId", json_is_string).is_ok()
        && json_require(object, "label", json_is_string).is_ok()
        && json_optional(object, "thinkingLevels", |value| {
            json_array_of(value, json_is_string)
        })
        .is_ok()
        && json_optional(object, "defaultThinkingLevel", json_is_string).is_ok()
}

fn json_is_command_info(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "name", json_is_string).is_ok()
        && json_require(object, "source", |value| {
            matches!(
                value.as_str(),
                Some("extension" | "prompt" | "skill" | "builtin")
            )
        })
        .is_ok()
        && json_optional(object, "description", json_is_string).is_ok()
        && json_optional(object, "argumentHint", json_is_string).is_ok()
}

fn json_is_file_info(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "path", json_is_string).is_ok()
        && json_require(object, "isDirectory", json_is_bool).is_ok()
}

fn json_is_model_defaults(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_optional(object, "modelId", json_is_string).is_ok()
        && json_optional(object, "thinkingLevel", json_is_string).is_ok()
        && json_require(object, "favorites", |value| {
            json_array_of(value, json_is_string)
        })
        .is_ok()
        && json_optional(object, "defaultPermissionMonitor", |value| {
            matches!(
                value.as_str(),
                Some("standard" | "bypass" | "bypass_plus" | "autonomous")
            )
        })
        .is_ok()
}

fn json_is_goal(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "summary", json_is_string).is_ok()
        && json_require(object, "lifecycle", json_is_string).is_ok()
}

fn json_is_flagged_file(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "path", json_is_string).is_ok()
        && json_require(object, "mode", |value| {
            matches!(value.as_str(), Some("included" | "referenced"))
        })
        .is_ok()
}

fn json_is_todo(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "id", json_is_i64).is_ok()
        && json_require(object, "title", json_is_string).is_ok()
        && json_require(object, "description", json_is_string).is_ok()
        && json_require(object, "status", |value| {
            matches!(
                value.as_str(),
                Some("pending" | "in_progress" | "done" | "blocked")
            )
        })
        .is_ok()
        && json_require(object, "dependencies", |value| {
            json_array_of(value, json_is_i64)
        })
        .is_ok()
        && json_optional(object, "createdAt", json_is_string).is_ok()
}

fn json_is_session_attention(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "sessionId", json_is_string).is_ok()
        && json_require(object, "phase", |value| {
            matches!(
                value.as_str(),
                Some("running" | "waiting" | "failed" | "done")
            )
        })
        .is_ok()
        && json_optional(object, "activity", json_is_string).is_ok()
        && json_optional(object, "pendingCount", json_is_i64).is_ok()
        && json_optional(object, "pendingTitle", json_is_string).is_ok()
        && json_require(object, "updatedAt", json_is_string).is_ok()
}

fn json_is_background_job(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "handle", json_is_string).is_ok()
        && json_require(object, "kind", |value| {
            matches!(value.as_str(), Some("shell" | "subagent"))
        })
        .is_ok()
        && json_require(object, "status", |value| {
            matches!(
                value.as_str(),
                Some("reserved" | "running" | "completed" | "failed" | "cancelled")
            )
        })
        .is_ok()
        && json_require(object, "toolName", json_is_string).is_ok()
        && json_require(object, "createdAt", json_is_string).is_ok()
        && json_require(object, "updatedAt", json_is_string).is_ok()
        && json_optional(object, "endedAt", json_is_string).is_ok()
        && json_optional(object, "startedAt", json_is_string).is_ok()
        && json_optional(object, "subagentType", json_is_string).is_ok()
        && json_optional(object, "model", json_is_string).is_ok()
        && json_optional(object, "subagentHandle", json_is_string).is_ok()
        && json_optional(object, "expiring", json_is_bool).is_ok()
        && json_optional(object, "outputTail", json_is_string).is_ok()
        && json_optional(object, "outputBytes", json_is_i64).is_ok()
}

fn json_is_workspace(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "workspaceId", json_is_string).is_ok()
        && json_require(object, "path", json_is_string).is_ok()
        && json_optional(object, "displayName", json_is_string).is_ok()
}

fn json_is_snapshot(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let valid_goal = |value: &serde_json::Value| value.is_null() || json_is_goal(value);
    json_require(object, "ref", json_is_session_ref).is_ok()
        && json_require(object, "workspace", json_is_workspace).is_ok()
        && json_require(object, "title", json_is_string).is_ok()
        && json_require(object, "status", |value| {
            matches!(
                value.as_str(),
                Some("idle" | "initializing" | "running" | "failed")
            )
        })
        .is_ok()
        && json_require(object, "updatedAt", json_is_string).is_ok()
        && json_optional(object, "archivedAt", json_is_string).is_ok()
        && json_optional(object, "preview", json_is_string).is_ok()
        && json_optional(object, "config", json_is_session_config).is_ok()
        && json_optional(object, "usage", json_is_usage).is_ok()
        && json_optional(object, "runningRunId", json_is_string).is_ok()
        && json_optional(object, "queuedMessages", |value| {
            json_array_of(value, json_is_queued_message)
        })
        .is_ok()
        && json_optional(object, "facet", json_is_string).is_ok()
        && json_optional(object, "permissionMonitor", |value| {
            matches!(
                value.as_str(),
                Some("standard" | "bypass" | "bypass_plus" | "autonomous")
            )
        })
        .is_ok()
        && json_optional(object, "adventurousHandoff", json_is_bool).is_ok()
        && json_optional(object, "notificationAutodrain", json_is_bool).is_ok()
        && json_optional(object, "activePlan", json_is_string).is_ok()
        && json_optional(object, "goal", valid_goal).is_ok()
        && json_optional(object, "flags", |value| {
            json_array_of(value, json_is_flagged_file)
        })
        .is_ok()
        && json_optional(object, "todos", |value| json_array_of(value, json_is_todo)).is_ok()
        && json_optional(object, "mcpServers", |value| {
            json_array_of(value, json_is_mcp_info)
        })
        .is_ok()
        && json_optional(object, "cwd", json_is_string).is_ok()
        && json_optional(object, "cwdStackDepth", json_is_i64).is_ok()
}

fn json_is_session_ref(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "workspaceId", json_is_string).is_ok()
        && json_require(object, "sessionId", json_is_string).is_ok()
}

fn json_is_session_list_entry(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "sessionId", json_is_string).is_ok()
        && json_require(object, "path", json_is_string).is_ok()
        && json_require(object, "cwd", json_is_string).is_ok()
        && json_optional(object, "displayName", json_is_string).is_ok()
        && json_require(object, "preview", json_is_string).is_ok()
        && json_require(object, "userMessageCount", json_is_i64).is_ok()
        && json_require(object, "updatedAt", json_is_string).is_ok()
        && json_require(object, "createdAt", json_is_string).is_ok()
        && json_require(object, "lastUserMessageAt", json_is_string).is_ok()
        && json_optional(object, "parentSessionPath", json_is_string).is_ok()
        && json_optional(object, "usage", json_is_usage).is_ok()
        && json_require(object, "archived", json_is_bool).is_ok()
        && json_optional(object, "lifecycle", |value| {
            matches!(
                value.as_str(),
                Some("emptyDefault" | "acceptedPrompt" | "liveConfigAction" | "unknown")
            )
        })
        .is_ok()
}

fn json_is_qna_question(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    json_require(object, "question", json_is_string).is_ok()
        && json_optional(object, "context", json_is_string).is_ok()
        && json_optional(object, "options", |value| {
            json_array_of(value, |item| {
                let Some(option) = item.as_object() else {
                    return false;
                };
                json_require(option, "label", json_is_string).is_ok()
                    && json_optional(option, "description", json_is_string).is_ok()
            })
        })
        .is_ok()
        && json_optional(object, "multiSelect", json_is_bool).is_ok()
}

fn json_is_host_ui_request(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(kind) = object.get("kind").and_then(serde_json::Value::as_str) else {
        return false;
    };
    if json_require(object, "requestId", json_is_string).is_err() {
        return false;
    }
    match kind {
        "confirm" => {
            json_require(object, "title", json_is_string).is_ok()
                && json_require(object, "message", json_is_string).is_ok()
                && json_optional(object, "defaultValue", json_is_bool).is_ok()
                && json_optional(object, "timeoutMs", json_is_i64).is_ok()
        }
        "input" => {
            json_require(object, "title", json_is_string).is_ok()
                && json_optional(object, "placeholder", json_is_string).is_ok()
                && json_optional(object, "initialValue", json_is_string).is_ok()
                && json_optional(object, "timeoutMs", json_is_i64).is_ok()
        }
        "select" => {
            json_require(object, "title", json_is_string).is_ok()
                && json_require(object, "options", |value| {
                    json_array_of(value, json_is_string)
                })
                .is_ok()
                && json_optional(object, "allowMultiple", json_is_bool).is_ok()
                && json_optional(object, "timeoutMs", json_is_i64).is_ok()
        }
        "editor" => {
            json_require(object, "title", json_is_string).is_ok()
                && json_optional(object, "initialValue", json_is_string).is_ok()
        }
        "qna" => {
            json_optional(object, "title", json_is_string).is_ok()
                && json_require(object, "questions", |value| {
                    json_array_of(value, json_is_qna_question)
                })
                .is_ok()
                && json_optional(object, "timeoutMs", json_is_i64).is_ok()
        }
        "plan" => {
            json_require(object, "title", json_is_string).is_ok()
                && json_require(object, "planText", json_is_string).is_ok()
                && json_optional(object, "displayPath", json_is_string).is_ok()
                && json_optional(object, "targetFacet", json_is_string).is_ok()
                && json_require(object, "actionLabels", |value| {
                    value
                        .as_array()
                        .is_some_and(|items| items.len() == 3 && items.iter().all(json_is_string))
                })
                .is_ok()
                && json_optional(object, "refuseLabel", json_is_string).is_ok()
                && json_optional(object, "timeoutMs", json_is_i64).is_ok()
        }
        "permission" => {
            json_require(object, "title", json_is_string).is_ok()
                && json_require(object, "toolName", |value| {
                    value.is_null() || json_is_string(value)
                })
                .is_ok()
                && json_require(object, "toolInput", |value| {
                    value.is_null() || json_is_string(value)
                })
                .is_ok()
                && json_require(object, "options", |value| {
                    json_array_of(value, json_is_string)
                })
                .is_ok()
                && json_optional(object, "timeoutMs", json_is_i64).is_ok()
        }
        "unknown" => {
            json_require(object, "title", json_is_string).is_ok()
                && json_require(object, "message", json_is_string).is_ok()
        }
        "notify" => {
            json_require(object, "message", json_is_string).is_ok()
                && json_optional(object, "level", |value| {
                    matches!(value.as_str(), Some("info" | "warning" | "error"))
                })
                .is_ok()
        }
        "status" => {
            json_require(object, "key", json_is_string).is_ok()
                && json_optional(object, "text", json_is_string).is_ok()
        }
        "widget" => {
            json_require(object, "key", json_is_string).is_ok()
                && json_optional(object, "lines", |value| {
                    json_array_of(value, json_is_string)
                })
                .is_ok()
                && json_optional(object, "placement", |value| {
                    matches!(value.as_str(), Some("aboveComposer" | "belowComposer"))
                })
                .is_ok()
        }
        "title" => json_require(object, "title", json_is_string).is_ok(),
        "editorText" => json_require(object, "text", json_is_string).is_ok(),
        "reset" => true,
        _ => false,
    }
}

fn json_is_session_event(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if json_require(object, "type", json_is_string).is_err()
        || json_require(object, "sessionRef", json_is_session_ref).is_err()
        || json_require(object, "timestamp", json_is_string).is_err()
        || json_optional(object, "runId", json_is_string).is_err()
        || json_optional(object, "subagentHandle", json_is_string).is_err()
    {
        return false;
    }
    let Some(kind) = object.get("type").and_then(serde_json::Value::as_str) else {
        return false;
    };
    match kind {
        "sessionOpened" | "sessionUpdated" => {
            json_require(object, "snapshot", json_is_snapshot).is_ok()
        }
        "assistantDelta" => {
            json_require(object, "text", json_is_string).is_ok()
                && json_optional(object, "channel", |value| {
                    matches!(value.as_str(), Some("text" | "thinking"))
                })
                .is_ok()
                && json_optional(object, "entryId", json_is_string).is_ok()
        }
        "queuedMessageStarted" => json_require(object, "message", json_is_queued_message).is_ok(),
        "queueUpdated" => json_require(object, "messages", |value| {
            json_array_of(value, json_is_queued_message)
        })
        .is_ok(),
        "userMessage" => {
            json_require(object, "id", json_is_string).is_ok()
                && json_require(object, "text", json_is_string).is_ok()
                && json_optional(object, "images", |value| {
                    json_array_of(value, json_is_image)
                })
                .is_ok()
                && json_optional(object, "entryId", json_is_string).is_ok()
                && json_optional(object, "references", |value| {
                    json_array_of(value, json_is_resolved_ref)
                })
                .is_ok()
        }
        "customMessage" => {
            json_require(object, "id", json_is_string).is_ok()
                && json_require(object, "customType", json_is_string).is_ok()
                && json_require(object, "text", json_is_string).is_ok()
                && json_require(object, "display", json_is_bool).is_ok()
                && json_optional(object, "turnBoundary", json_is_bool).is_ok()
        }
        "toolStarted" => {
            json_require(object, "toolName", json_is_string).is_ok()
                && json_require(object, "callId", json_is_string).is_ok()
                && json_optional(object, "label", json_is_string).is_ok()
                && json_optional(object, "description", json_is_string).is_ok()
        }
        "toolUpdated" => {
            json_require(object, "callId", json_is_string).is_ok()
                && json_optional(object, "text", json_is_string).is_ok()
                && json_optional(object, "progress", |value| value.is_number()).is_ok()
        }
        "toolFinished" => {
            json_require(object, "callId", json_is_string).is_ok()
                && json_require(object, "success", json_is_bool).is_ok()
                && json_optional(object, "images", |value| {
                    json_array_of(value, json_is_image)
                })
                .is_ok()
                && json_optional(object, "interrupted", json_is_bool).is_ok()
        }
        "runCompleted" => {
            json_require(object, "snapshot", json_is_snapshot).is_ok()
                && json_optional(object, "userEntryId", json_is_string).is_ok()
                && json_optional(object, "assistantEntryId", json_is_string).is_ok()
        }
        "usageUpdated" => json_require(object, "usage", json_is_usage).is_ok(),
        "runFailed" => {
            let Some(error) = object.get("error").and_then(serde_json::Value::as_object) else {
                return false;
            };
            json_require(error, "message", json_is_string).is_ok()
                && json_optional(error, "code", json_is_string).is_ok()
        }
        "hostUiRequest" => json_require(object, "request", json_is_host_ui_request).is_ok(),
        "hostUiResolved" => json_require(object, "requestId", json_is_string).is_ok(),
        "extensionCompatibilityIssue" => {
            let Some(issue) = object.get("issue").and_then(serde_json::Value::as_object) else {
                return false;
            };
            json_require(issue, "capability", json_is_string).is_ok()
                && json_require(issue, "classification", |value| {
                    value.as_str() == Some("terminal-only")
                })
                .is_ok()
                && json_require(issue, "message", json_is_string).is_ok()
                && json_optional(issue, "extensionPath", json_is_string).is_ok()
                && json_optional(issue, "eventName", json_is_string).is_ok()
        }
        "sessionClosed" => json_require(object, "reason", |value| {
            matches!(value.as_str(), Some("manual" | "ended" | "failed"))
        })
        .is_ok(),
        "sessionReset" => true,
        "nestedReplayStatus" => {
            json_require(object, "subagentHandle", json_is_string).is_ok()
                && json_require(object, "status", |value| {
                    matches!(
                        value.as_str(),
                        Some("loading" | "available" | "unavailable")
                    )
                })
                .is_ok()
                && json_optional(object, "reason", json_is_string).is_ok()
        }
        _ => false,
    }
}

/// Validate the required shape of a known server variant before serde. Serde
/// remains the detailed decoder, while these shape-aware validators enforce the
/// same required/optional/null rules as the TypeScript ingress. Unknown fields
/// are deliberately ignored, including unknown nested objects.
fn json_server_shape_is_valid(
    object: &serde_json::Map<String, serde_json::Value>,
    kind: &str,
) -> bool {
    match kind {
        "hello" => {
            json_server_required_fields(
                object,
                &[
                    ("protocolVersion", json_is_u64),
                    ("serverId", json_is_string),
                    ("dataDir", json_is_string),
                ],
            ) && json_optional(object, "serverLabel", json_is_string).is_ok()
                && json_optional(object, "buildSha", json_is_string).is_ok()
        }
        "pong" => true,
        "seed" => {
            json_server_required_fields(
                object,
                &[
                    ("epoch", json_is_u64),
                    ("seq", json_is_u64),
                    ("events", |value| {
                        json_array_of(value, json_is_session_event)
                    }),
                ],
            ) && json_server_nullable_required(object, "sessionId", json_is_string)
        }
        "event" => json_server_required_fields(
            object,
            &[
                ("epoch", json_is_u64),
                ("seq", json_is_u64),
                ("event", json_is_session_event),
            ],
        ),
        "sessionList" => {
            json_server_required_fields(
                object,
                &[
                    ("sessions", |value| {
                        json_array_of(value, json_is_session_list_entry)
                    }),
                    ("defaultNewSessionCwd", json_is_string),
                ],
            ) && json_server_nullable_required(object, "activeSessionId", json_is_string)
        }
        "sessionStatus" => {
            json_server_required_fields(
                object,
                &[("runningIds", |value| json_array_of(value, json_is_string))],
            ) && json_optional(object, "initializingIds", |value| {
                json_array_of(value, json_is_string)
            })
            .is_ok()
                && json_optional(object, "attention", |value| {
                    json_array_of(value, json_is_session_attention)
                })
                .is_ok()
        }
        "modelList" => {
            json_server_required_fields(
                object,
                &[("models", |value| json_array_of(value, json_is_model_option))],
            ) && json_optional(object, "diagnostic", json_is_diagnostic).is_ok()
        }
        "commandList" => json_server_required_fields(
            object,
            &[("commands", |value| {
                json_array_of(value, json_is_command_info)
            })],
        ),
        "facetList" => json_server_required_fields(
            object,
            &[("facets", |value| json_array_of(value, json_is_string))],
        ),
        "jobsList" => json_server_required_fields(
            object,
            &[("jobs", |value| json_array_of(value, json_is_background_job))],
        ),
        "fileIndex" => {
            json_server_required_fields(
                object,
                &[("files", |value| json_array_of(value, json_is_file_info))],
            ) && json_optional(object, "truncated", json_is_bool).is_ok()
        }
        "fileList" => {
            json_server_required_fields(
                object,
                &[
                    ("query", json_is_string),
                    ("files", |value| json_array_of(value, json_is_file_info)),
                ],
            ) && json_optional(object, "includeIgnored", json_is_bool).is_ok()
        }
        "atRefs" => json_server_required_fields(
            object,
            &[
                ("skills", |value| json_array_of(value, json_is_string)),
                ("subagents", |value| json_array_of(value, json_is_string)),
            ],
        ),
        "dirListing" => {
            json_server_required_fields(
                object,
                &[
                    ("requestId", json_is_u64),
                    ("path", json_is_string),
                    ("entries", |value| json_array_of(value, json_is_string)),
                ],
            ) && json_server_nullable_required(object, "parent", json_is_string)
        }
        "pathStat" => json_server_required_fields(
            object,
            &[
                ("requestId", json_is_u64),
                ("path", json_is_string),
                ("exists", json_is_bool),
                ("isDir", json_is_bool),
            ],
        ),
        "modelDefaults" => object.get("defaults").is_some_and(json_is_model_defaults),
        "pantokenSettings" => {
            let Some(settings) = object
                .get("settings")
                .and_then(serde_json::Value::as_object)
            else {
                return false;
            };
            let Some(env) = object.get("env").and_then(serde_json::Value::as_object) else {
                return false;
            };
            json_server_required_fields(object, &[("pendingRestart", json_is_bool)])
                && json_server_nullable_required(settings, "loginShell", json_is_string)
                && json_server_nullable_required(settings, "backgroundModel", json_is_string)
                && json_server_nullable_required(env, "activeShell", json_is_string)
                && json_server_required_fields(env, &[("ok", json_is_bool)])
                && json_optional(settings, "enabledExtensions", |value| {
                    value.is_null() || json_array_of(value, json_is_string)
                })
                .is_ok()
                && json_optional(env, "detail", json_is_string).is_ok()
        }
        "trustRequest" => json_server_required_fields(
            object,
            &[
                ("requestId", json_is_string),
                ("cwd", json_is_string),
                ("title", json_is_string),
                ("options", |value| {
                    json_array_of(value, |item| {
                        let Some(option) = item.as_object() else {
                            return false;
                        };
                        json_require(option, "label", json_is_string).is_ok()
                            && json_require(option, "trusted", json_is_bool).is_ok()
                    })
                }),
            ],
        ),
        "trustResolved" => json_server_required_fields(object, &[("requestId", json_is_string)]),
        "updateStatus" => {
            json_server_required_fields(
                object,
                &[("available", json_is_bool), ("applying", json_is_bool)],
            ) && json_optional(object, "sha", json_is_string).is_ok()
                && json_optional(object, "status", json_is_string).is_ok()
                && json_optional(object, "reason", json_is_string).is_ok()
                && json_optional(object, "desktopStale", json_is_bool).is_ok()
        }
        "editorPrefill" => json_server_required_fields(object, &[("text", json_is_string)]),
        "promptResult" => {
            json_server_required_fields(
                object,
                &[("promptId", json_is_string), ("accepted", json_is_bool)],
            ) && json_optional(object, "sessionId", json_is_string).is_ok()
                && json_optional(object, "error", json_is_string).is_ok()
        }
        "queueRestored" => json_server_required_fields(
            object,
            &[
                ("steering", |value| json_array_of(value, json_is_string)),
                ("followUp", |value| json_array_of(value, json_is_string)),
            ],
        ),
        "abortResult" => {
            json_server_required_fields(object, &[("accepted", json_is_bool)])
                && json_optional(object, "requestId", json_is_string).is_ok()
                && json_optional(object, "error", json_is_string).is_ok()
        }
        "error" => {
            json_server_required_fields(object, &[("message", json_is_string)])
                && json_optional(object, "kind", json_is_string).is_ok()
        }
        _ => false,
    }
}

/// Parse a raw JSON string into a ServerMessage. Returns None on parse failure.
pub fn parse_server_message(raw: &str) -> Option<ServerMessage> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    let kind = object.get("type")?.as_str()?;
    match kind {
        "hello" | "pong" | "seed" | "event" | "sessionList" | "sessionStatus" | "modelList"
        | "commandList" | "facetList" | "jobsList" | "fileIndex" | "fileList" | "atRefs"
        | "dirListing" | "pathStat" | "modelDefaults" | "pantokenSettings" | "trustRequest"
        | "trustResolved" | "updateStatus" | "editorPrefill" | "promptResult" | "queueRestored"
        | "abortResult" | "error" => {}
        _ => return None,
    }
    if !json_server_shape_is_valid(object, kind) {
        return None;
    }
    if kind == "updateStatus" {
        if let Some(status) = object.get("status") {
            if !matches!(status.as_str(), Some("deferred" | "rejected")) {
                return None;
            }
        }
        if let Some(reason) = object.get("reason") {
            if !matches!(reason.as_str(), Some("busy" | "failed")) {
                return None;
            }
        }
    }
    if kind == "error" {
        if let Some(error_kind) = object.get("kind") {
            if !matches!(
                error_kind.as_str(),
                Some("session-switch" | "abort" | "sessionAction" | "destroySession")
            ) {
                return None;
            }
        }
    }
    serde_json::from_value(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_driver::{SessionRef, Timestamp};

    fn make_session_ref() -> SessionRef {
        SessionRef {
            workspace_id: "ws1".into(),
            session_id: "s1".into(),
        }
    }

    #[test]
    fn roundtrip_destroy_session() {
        let msg = ClientMessage::DestroySession {
            path: "/sessions/demo/session.json".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(
            json,
            r#"{"type":"destroySession","path":"/sessions/demo/session.json"}"#
        );
        // Compare via re-serialization since ClientMessage doesn't derive PartialEq.
        let parsed = serde_json::from_str::<ClientMessage>(&json).unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), json);
    }

    #[test]
    fn roundtrip_hello() {
        let msg = ClientMessage::Hello {
            auth: Some("token".into()),
            resume: Some(ResumeToken {
                session_id: "s1".into(),
                epoch: 1,
                seq: 5,
            }),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::Hello { auth, resume } => {
                assert_eq!(auth, Some("token".to_string()));
                assert_eq!(resume.unwrap().seq, 5);
            }
            _ => panic!("expected Hello"),
        }
    }

    #[test]
    fn roundtrip_prompt() {
        let json_str = r#"{
            "type": "prompt",
            "promptId": "p1",
            "text": "Hello world",
            "sessionId": "s1"
        }"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::Prompt {
                prompt_id,
                text,
                session_id,
                ..
            } => {
                assert_eq!(prompt_id, Some("p1".to_string()));
                assert_eq!(text, "Hello world");
                assert_eq!(session_id.as_ref().map(|id| id.as_ref()), Some("s1"));
            }
            _ => panic!("expected Prompt"),
        }
    }

    #[test]
    fn roundtrip_server_event() {
        let ev = SessionDriverEvent::SessionReset {
            base: crate::session_driver::SessionEventBase {
                session_ref: make_session_ref(),
                timestamp: Timestamp::from("2026-07-03T12:00:00Z"),
                run_id: None,
                subagent_handle: None,
            },
        };
        let msg = ServerMessage::Event {
            event: ev,
            epoch: 1,
            seq: 3,
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::Event { epoch, seq, .. } => {
                assert_eq!(epoch, 1);
                assert_eq!(seq, 3);
            }
            _ => panic!("expected Event"),
        }
    }

    #[test]
    fn roundtrip_server_seed() {
        let json_str = r#"{
            "type": "seed",
            "sessionId": "s1",
            "epoch": 0,
            "seq": 0,
            "events": []
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::Seed {
                session_id, events, ..
            } => {
                assert_eq!(session_id.as_ref().map(AsRef::as_ref), Some("s1"));
                assert!(events.is_empty());
            }
            _ => panic!("expected Seed"),
        }
    }

    #[test]
    fn at_refs_serializes_flattened_not_nested_under_refs() {
        // `AtRefs { refs: AtRefs }` uses `#[serde(flatten)]` precisely so `refs`
        // never appears as a JSON key — regression guard for that flatten (a
        // dropped `#[serde(flatten)]` would silently nest `skills`/`subagents`
        // one level deeper and the client's `atRefs` fold would stop matching).
        let msg = ServerMessage::AtRefs {
            refs: AtRefs {
                skills: vec!["debug".to_string(), "journal".to_string()],
                subagents: vec!["reviewer".to_string()],
            },
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "atRefs",
                "skills": ["debug", "journal"],
                "subagents": ["reviewer"],
            })
        );

        let parsed: ServerMessage = serde_json::from_value(json).unwrap();
        match parsed {
            ServerMessage::AtRefs { refs } => {
                assert_eq!(
                    refs.skills,
                    vec!["debug".to_string(), "journal".to_string()]
                );
                assert_eq!(refs.subagents, vec!["reviewer".to_string()]);
            }
            _ => panic!("expected AtRefs"),
        }
    }

    #[test]
    fn query_files_include_ignored_omitted_when_absent_present_when_set() {
        // Regression guard for the Shift+Tab ignore-toggle plumbing: `includeIgnored`
        // must round-trip as an omitted key (not `null`) when unset, matching the TS
        // `includeIgnored?: boolean` — an older server/client pair that never sends
        // the field must not choke on a missing key.
        let without = ClientMessage::QueryFiles {
            query: "foo".into(),
            cwd: None,
            include_ignored: None,
        };
        let json = serde_json::to_value(&without).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "type": "queryFiles", "query": "foo" })
        );

        let with_flag = ClientMessage::QueryFiles {
            query: "foo".into(),
            cwd: None,
            include_ignored: Some(true),
        };
        let json = serde_json::to_value(&with_flag).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "type": "queryFiles", "query": "foo", "includeIgnored": true })
        );

        let parsed: ClientMessage = serde_json::from_value(json).unwrap();
        match parsed {
            ClientMessage::QueryFiles {
                include_ignored, ..
            } => {
                assert_eq!(include_ignored, Some(true));
            }
            _ => panic!("expected QueryFiles"),
        }
    }

    #[test]
    fn file_list_echoes_include_ignored() {
        // `fileList`'s echoed flag is the staleness guard alongside `query`: a
        // toggled request must not be satisfied by a stale untoggled response.
        let msg = ServerMessage::FileList {
            query: "foo".into(),
            files: vec![],
            include_ignored: Some(true),
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "fileList",
                "query": "foo",
                "files": [],
                "includeIgnored": true,
            })
        );

        let parsed: ServerMessage = serde_json::from_value(json).unwrap();
        match parsed {
            ServerMessage::FileList {
                include_ignored, ..
            } => {
                assert_eq!(include_ignored, Some(true));
            }
            _ => panic!("expected FileList"),
        }
    }

    #[test]
    fn roundtrip_server_session_list() {
        let json_str = r#"{
            "type": "sessionList",
            "sessions": [],
            "activeSessionId": null,
            "defaultNewSessionCwd": "/home"
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::SessionList {
                default_new_session_cwd,
                ..
            } => {
                assert_eq!(default_new_session_cwd, "/home");
            }
            _ => panic!("expected SessionList"),
        }
    }

    #[test]
    fn roundtrip_new_session() {
        let json_str = r#"{
            "type": "newSession",
            "cwd": "/home/project",
            "model": {"modelId": "claude-4"},
            "thinking": "high",
            "prompt": "Build something"
        }"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::NewSession {
                cwd,
                model,
                thinking,
                prompt,
                ..
            } => {
                assert_eq!(cwd, Some("/home/project".to_string()));
                assert_eq!(model.unwrap().model_id, "claude-4");
                assert_eq!(thinking, Some("high".to_string()));
                assert_eq!(prompt, Some("Build something".to_string()));
            }
            _ => panic!("expected NewSession"),
        }
    }

    #[test]
    fn roundtrip_session_action_set_mcp_server() {
        let json_str = r#"{
            "type": "sessionAction",
            "action": {
                "kind": "setMcpServer",
                "serverName": "my-server",
                "action": "reconnect"
            }
        }"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::SessionAction {
                action:
                    SessionAction::SetMcpServer {
                        server_name,
                        action,
                    },
                ..
            } => {
                assert_eq!(server_name, "my-server");
                assert_eq!(action, McpAction::Reconnect);
            }
            _ => panic!("expected SessionAction::SetMcpServer"),
        }
    }

    #[test]
    fn roundtrip_session_action_payload_free_kinds() {
        for (json_kind, expected) in [
            ("compact", SessionAction::Compact),
            ("clearContext", SessionAction::ClearContext),
            (
                "toggleAdventurousHandoff",
                SessionAction::ToggleAdventurousHandoff,
            ),
            ("resetShell", SessionAction::ResetShell),
            ("daemonReload", SessionAction::DaemonReload),
            ("goalPause", SessionAction::GoalPause),
            ("goalResume", SessionAction::GoalResume),
            ("goalClear", SessionAction::GoalClear),
        ] {
            let json_str = format!(
                r#"{{"type": "sessionAction", "action": {{"kind": "{json_kind}"}}, "sessionId": "s1"}}"#
            );
            let msg = parse_client_message(&json_str).unwrap();
            match msg {
                ClientMessage::SessionAction { action, session_id } => {
                    assert_eq!(action, expected);
                    assert_eq!(session_id.as_ref().map(|id| id.as_ref()), Some("s1"));
                }
                _ => panic!("expected SessionAction for kind {json_kind}"),
            }
        }
    }

    #[test]
    fn roundtrip_session_action_payload_variants() {
        // goalSet
        let json_str = r#"{"type": "sessionAction", "action": {"kind": "goalSet", "summary": "ship it"}, "sessionId": "s1"}"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::SessionAction {
                action: SessionAction::GoalSet { summary },
                ..
            } => assert_eq!(summary, "ship it"),
            _ => panic!("expected SessionAction::GoalSet"),
        }

        // setTitle
        let json_str = r#"{"type": "sessionAction", "action": {"kind": "setTitle", "title": "my title"}, "sessionId": "s1"}"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::SessionAction {
                action: SessionAction::SetTitle { title },
                ..
            } => assert_eq!(title, "my title"),
            _ => panic!("expected SessionAction::SetTitle"),
        }
    }

    #[test]
    fn roundtrip_session_action_set_model_with_thinking_level() {
        // SetModel with thinkingLevel — the combined model+effort action.
        let json_str = r#"{"type": "sessionAction", "action": {"kind": "setModel", "modelId": "claude-opus", "thinkingLevel": "high"}, "sessionId": "s1"}"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::SessionAction {
                action:
                    SessionAction::SetModel {
                        model_id,
                        thinking_level,
                    },
                ..
            } => {
                assert_eq!(model_id, "claude-opus");
                assert_eq!(thinking_level.as_deref(), Some("high"));
            }
            _ => panic!("expected SessionAction::SetModel"),
        }

        // SetModel without thinkingLevel — the field is optional (defaults to None).
        let json_str = r#"{"type": "sessionAction", "action": {"kind": "setModel", "modelId": "gpt-5"}, "sessionId": "s1"}"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::SessionAction {
                action:
                    SessionAction::SetModel {
                        model_id,
                        thinking_level,
                    },
                ..
            } => {
                assert_eq!(model_id, "gpt-5");
                assert!(thinking_level.is_none());
            }
            _ => panic!("expected SessionAction::SetModel"),
        }
    }

    #[test]
    fn roundtrip_trust_response() {
        let json_str = r#"{
            "type": "trustResponse",
            "requestId": "r1",
            "choice": 0
        }"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::TrustResponse { request_id, choice } => {
                assert_eq!(request_id, "r1");
                assert_eq!(choice, Some(0));
            }
            _ => panic!("expected TrustResponse"),
        }
    }

    #[test]
    fn parse_client_value_is_public_and_tolerant_of_unknown_fields() {
        let value = serde_json::json!({
            "type": "prompt",
            "text": "hello",
            "sessionId": "s1",
            "futureField": true,
        });
        let parsed = parse_client_message_value(value).unwrap();
        assert!(matches!(parsed, ClientMessage::Prompt { .. }));
        assert!(parse_client_message_value(serde_json::json!({"type": "future"})).is_err());
        assert!(parse_client_message_value(serde_json::json!({"type": "prompt"})).is_err());
        assert!(
            parse_client_message_value(serde_json::json!({
                "type": "respondUi",
                "response": {"requestId": "r", "cancelled": false}
            }))
            .is_err()
        );
        assert!(
            parse_client_message_value(serde_json::json!({
                "type": "respondUi",
                "response": {"requestId": "r", "value": "ok", "cancelled": false}
            }))
            .is_ok()
        );
        assert!(
            parse_client_message_value(serde_json::json!({
                "type": "prompt", "text": "hello", "sessionId": null
            }))
            .is_err()
        );
        assert!(
            parse_client_message_value(serde_json::json!({
                "type": "hello", "resume": {"sessionId": "s", "epoch": 1, "seq": 2}
            }))
            .is_ok()
        );
        assert!(
            parse_client_message_value(serde_json::json!({
                "type": "hello", "resume": {"sessionId": null, "epoch": 1, "seq": 2}
            }))
            .is_err()
        );
        assert!(
            parse_client_message_value(serde_json::json!({
                "type": "abort", "sessionId": null
            }))
            .is_err()
        );
        assert!(
            parse_client_message_value(serde_json::json!({
                "type": "setLoginShell"
            }))
            .is_err()
        );
        assert!(
            parse_client_message_value(serde_json::json!({
                "type": "trustResponse", "requestId": "r"
            }))
            .is_err()
        );
        assert!(
            parse_client_message_value(serde_json::json!({
                "type": "trustResponse", "requestId": "r", "choice": null
            }))
            .is_ok()
        );
        assert!(parse_client_message_value(serde_json::json!([])).is_err());
    }

    #[test]
    fn parse_server_closed_fields_and_unknown_keys() {
        assert!(parse_server_message(r#"{"type":"updateStatus","available":false,"applying":false,"status":"rejected","reason":"failed","future":true}"#).is_some());
        assert!(
            parse_server_message(
                r#"{"type":"updateStatus","available":false,"applying":false,"status":"bogus"}"#
            )
            .is_none()
        );
        assert!(
            parse_server_message(
                r#"{"type":"updateStatus","available":false,"applying":false,"reason":"bogus"}"#
            )
            .is_none()
        );
        assert!(
            parse_server_message(
                r#"{"type":"hello","protocolVersion":6,"serverId":"s","dataDir":"/","buildSha":null}"#
            )
            .is_none()
        );
        assert!(
            parse_server_message(r#"{"type":"sessionStatus","runningIds":[],"attention":null}"#)
                .is_none()
        );
        assert!(
            parse_server_message(r#"{"type":"modelList","models":[],"diagnostic":null}"#).is_none()
        );
        assert!(
            parse_server_message(
                r#"{"type":"event","epoch":1,"seq":1,"event":{"type":"assistantDelta","sessionRef":{"workspaceId":"w","sessionId":"s"},"timestamp":"t","text":"x","channel":null}}"#
            )
            .is_none()
        );
        assert!(
            parse_server_message(
                r#"{"type":"hello","protocolVersion":6,"serverId":"s","dataDir":"/","future":{"input":null}}"#
            )
            .is_some()
        );
        assert!(
            parse_server_message(r#"{"type":"error","message":"x","future":{"sessionId":null}}"#)
                .is_some()
        );
        assert!(
            parse_server_message(
                r#"{"type":"event","epoch":1,"seq":1,"event":{"type":"hostUiRequest","sessionRef":{"workspaceId":"w","sessionId":"s"},"timestamp":"t","request":{"kind":"confirm","requestId":"r","title":"Confirm","message":"Proceed?","timeoutMs":null}}}"#
            )
            .is_none()
        );
        assert!(parse_server_message(r#"{"type":"modelDefaults","defaults":{}}"#).is_none());
        assert!(
            parse_server_message(
                r#"{"type":"sessionList","sessions":[{"sessionId":"s","path":"/s","cwd":"/","preview":"","userMessageCount":0,"updatedAt":"t","createdAt":"t","lastUserMessageAt":"t"}],"activeSessionId":null,"defaultNewSessionCwd":"/"}"#
            )
            .is_none()
        );
        assert!(
            parse_server_message(
                r#"{"type":"seed","sessionId":null,"epoch":0,"seq":0,"events":[]}"#
            )
            .is_some()
        );
        assert!(parse_server_message(r#"{"type":"sessionList","sessions":[],"activeSessionId":null,"defaultNewSessionCwd":"/"}"#).is_some());
        assert!(
            parse_server_message(
                r#"{"type":"dirListing","requestId":1,"path":"/","parent":null,"entries":[]}"#
            )
            .is_some()
        );
        assert!(parse_server_message(r#"{"type":"hello","protocolVersion":6,"serverId":"s","dataDir":"/","buildSha":"sha"}"#).is_some());
        assert!(
            parse_server_message(r#"{"type":"sessionStatus","runningIds":[],"attention":[]}"#)
                .is_some()
        );
        for kind in ["session-switch", "abort", "sessionAction", "destroySession"] {
            let raw = format!(r#"{{"type":"error","message":"failed","kind":"{kind}"}}"#);
            assert!(parse_server_message(&raw).is_some());
        }
        assert!(
            parse_server_message(r#"{"type":"error","message":"failed","kind":"bogus"}"#).is_none()
        );
        assert!(parse_server_message(r#"{"type":"future","future":true}"#).is_none());
    }

    #[test]
    fn parse_invalid_json_returns_none() {
        assert!(parse_client_message("not json").is_none());
        assert!(parse_client_message(r#"{"type": 42}"#).is_none());
        assert!(parse_client_message(r#"{"noType": true}"#).is_none());
    }

    #[test]
    fn roundtrip_server_hello() {
        let json_str = r#"{
            "type": "hello",
            "protocolVersion": 2,
            "serverId": "srv-abc",
            "dataDir": "/data"
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::Hello {
                protocol_version,
                server_id,
                data_dir,
                ..
            } => {
                assert_eq!(protocol_version, 2);
                assert_eq!(server_id, "srv-abc");
                assert_eq!(data_dir, "/data");
            }
            _ => panic!("expected Hello"),
        }
    }

    #[test]
    fn directory_queries_and_replies_echo_request_ids() {
        let query: ClientMessage =
            serde_json::from_str(r#"{"type":"queryDir","path":"~/src","requestId":17}"#).unwrap();
        match query {
            ClientMessage::QueryDir { path, request_id } => {
                assert_eq!(path.as_deref(), Some("~/src"));
                assert_eq!(request_id, 17);
            }
            _ => panic!("expected QueryDir"),
        }

        let reply: ServerMessage = serde_json::from_str(
            r#"{"type":"dirListing","path":"/home/me/src","parent":"/home/me","entries":[],"requestId":17}"#,
        )
        .unwrap();
        match reply {
            ServerMessage::DirListing {
                listing,
                request_id,
            } => {
                assert_eq!(listing.path, "/home/me/src");
                assert_eq!(request_id, 17);
            }
            _ => panic!("expected DirListing"),
        }
    }

    #[test]
    fn roundtrip_server_model_defaults() {
        let json_str = r#"{
            "type": "modelDefaults",
            "defaults": {"favorites": ["anthropic/claude-4"]}
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::ModelDefaults { defaults } => {
                assert_eq!(defaults.favorites, vec!["anthropic/claude-4"]);
            }
            _ => panic!("expected ModelDefaults"),
        }
    }

    #[test]
    fn roundtrip_server_model_list_diagnostic() {
        let json_str = r#"{
            "type": "modelList",
            "models": [],
            "diagnostic": {
                "kind": "couldNotBeParsed",
                "message": "no model entries"
            }
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::ModelList { models, diagnostic } => {
                assert!(models.is_empty());
                assert!(matches!(
                    diagnostic,
                    Some(ModelCatalogDiagnostic::CouldNotBeParsed { message })
                        if message == "no model entries"
                ));
            }
            _ => panic!("expected ModelList"),
        }
    }

    #[test]
    fn roundtrip_server_model_list_other_diagnostics() {
        for kind in ["emptyOutput", "noResponse"] {
            let json = format!(
                r#"{{"type":"modelList","models":[],"diagnostic":{{"kind":"{kind}","message":"diagnostic"}}}}"#
            );
            let msg: ServerMessage = serde_json::from_str(&json).unwrap();
            match msg {
                ServerMessage::ModelList { diagnostic, .. } => {
                    assert_eq!(
                        diagnostic.as_ref().map(|d| match d {
                            ModelCatalogDiagnostic::EmptyOutput { .. } => "emptyOutput",
                            ModelCatalogDiagnostic::NoResponse { .. } => "noResponse",
                            ModelCatalogDiagnostic::CouldNotBeParsed { .. } => "couldNotBeParsed",
                        }),
                        Some(kind)
                    );
                }
                _ => panic!("expected ModelList"),
            }
        }
    }

    #[test]
    fn roundtrip_branch() {
        let json_str = r#"{
            "type": "branch",
            "entryId": "e1",
            "summarize": true
        }"#;
        let msg = parse_client_message(json_str).unwrap();
        match msg {
            ClientMessage::Branch {
                entry_id,
                summarize,
                ..
            } => {
                assert_eq!(entry_id, "e1");
                assert_eq!(summarize, Some(true));
            }
            _ => panic!("expected Branch"),
        }
    }

    #[test]
    fn roundtrip_server_error() {
        let json_str = r#"{
            "type": "error",
            "message": "Something went wrong",
            "kind": "session-switch"
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::Error { message, kind } => {
                assert_eq!(message, "Something went wrong");
                assert_eq!(kind, Some("session-switch".to_string()));
            }
            _ => panic!("expected Error"),
        }
    }

    #[test]
    fn roundtrip_abort_result() {
        let json_str = r#"{
            "type": "abortResult",
            "requestId": "stop-1",
            "accepted": false,
            "error": "daemon did not receive stop"
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::AbortResult {
                request_id,
                accepted,
                error,
            } => {
                assert_eq!(request_id.as_deref(), Some("stop-1"));
                assert!(!accepted);
                assert_eq!(error.as_deref(), Some("daemon did not receive stop"));
            }
            _ => panic!("expected AbortResult"),
        }
    }

    #[test]
    fn roundtrip_server_pantoken_settings() {
        let json_str = r#"{
            "type": "pantokenSettings",
            "settings": {"loginShell": null, "backgroundModel": null, "enabledExtensions": null},
            "env": {"activeShell": "/bin/zsh", "ok": true},
            "pendingRestart": false
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::PantokenSettings {
                pending_restart, ..
            } => {
                assert!(!pending_restart);
            }
            _ => panic!("expected PantokenSettings"),
        }
    }

    #[test]
    fn roundtrip_ping() {
        let json_str = r#"{"type": "ping"}"#;
        let msg = parse_client_message(json_str).unwrap();
        assert!(matches!(msg, ClientMessage::Ping));
    }

    #[test]
    fn roundtrip_server_pong() {
        let msg = ServerMessage::Pong;
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, r#"{"type":"pong"}"#);
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, ServerMessage::Pong));
    }

    #[test]
    fn roundtrip_server_queue_restored() {
        let json_str = r#"{
            "type": "queueRestored",
            "steering": ["msg1"],
            "followUp": ["msg2"]
        }"#;
        let msg: ServerMessage = serde_json::from_str(json_str).unwrap();
        match msg {
            ServerMessage::QueueRestored {
                steering,
                follow_up,
            } => {
                assert_eq!(steering, vec!["msg1"]);
                assert_eq!(follow_up, vec!["msg2"]);
            }
            _ => panic!("expected QueueRestored"),
        }
    }
}
