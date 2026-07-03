//! The session hub: owns the per-session seq/epoch-stamped event journal — the
//! single authoritative per-session store — and fans stamped events out to all
//! connected WS clients. New clients get hello + a seed of journal events they
//! fold from zero; a reconnect with a valid resume token gets just the tail
//! replayed instead. The hub keeps no folded SessionState of its own: the rare
//! paths that need one (respondUi's pending gate, branch's running gate,
//! /debug/state) fold the journal on demand.
//!
//! Port of `server/src/hub.ts` (1967 lines).
//!
//! NOTE: This is a work-in-progress port. The core event-handling, tracking,
//! and journal management are ported. The handleClient switch, switchTo,
//! addClient, and client management are stubbed and will be filled in as the
//! next step. Dead-code warnings are expected until the full port is complete.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use pilot_protocol::session_driver::{
    HostUiRequest, ModelOption, SessionDriverEvent, SessionDriverEvent as E, SessionId,
    SessionRef, SessionStatus,
};
use pilot_protocol::state::{fold_all, fold_event, SessionState};
use pilot_protocol::wire::{ServerMessage, SessionAttention, SessionAttentionPhase};
use tokio::sync::mpsc;
use tracing::error;

use crate::driver::PilotDriver;
use crate::journal::{
    append_event, build_seed, bump_epoch, create_journal, meta_seed_events, try_merge,
    SessionJournal,
};

/// What the hub hands to a notifier (e.g. the Web Push sender) for notable events.
#[derive(Debug, Clone)]
pub struct HubNotification {
    pub title: String,
    pub body: String,
    pub tag: Option<String>,
    pub url: Option<String>,
}

/// Compact metadata for every warm session. Background transcripts stay private to the
/// driver; this map carries only enough state to route the operator's attention.
#[derive(Debug, Clone)]
struct AttentionRecord {
    phase: AttentionPhase,
    activity: Option<String>,
    updated_at: String,
    pending: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttentionPhase {
    Running,
    Failed,
    Done,
}

impl AttentionPhase {
    fn as_str(&self) -> &'static str {
        match self {
            AttentionPhase::Running => "running",
            AttentionPhase::Failed => "failed",
            AttentionPhase::Done => "done",
        }
    }
}

/// One connected client (WS connection). Focus is per-connection.
struct ClientConn {
    send: mpsc::Sender<ServerMessage>,
    /// The session this connection is viewing (None = the empty landing).
    focused_id: Option<SessionId>,
    /// Single-flight per connection: a swap can block, so only one runs at a time.
    switch_in_flight: bool,
    /// The latest switch queued behind an in-flight one.
    pending_switch: Option<PendingSwitch>,
}

/// A queued switch waiting for an in-flight one to finish.
struct PendingSwitch {
    /// The session id to resolve with (or None if the swap fails).
    resolve: tokio::sync::oneshot::Sender<Option<SessionId>>,
}

/// A pending assistantDelta being coalesced (N1).
struct PendingDelta {
    ev: SessionDriverEvent,
    /// Abort handle for the flush timer.
    timer_abort: tokio::sync::oneshot::Sender<()>,
}

/// A buffered swap-window event (attach-window race fix).
struct BufferedSwapEvent {
    at_ms: u128,
    ev: SessionDriverEvent,
}

const SWAP_BUFFER_CAP: usize = 256;
const SWAP_BUFFER_TTL_MS: u128 = 5000;

/// The session hub. Owns journals, client map, running/attention tracking,
/// and orchestrates the driver.
pub struct SessionHub {
    driver: Arc<dyn PilotDriver>,
    notify: Option<Arc<dyn Fn(HubNotification) + Send + Sync>>,
    live_refresh_ms: u64,
    server_id: String,
    data_dir: Option<PathBuf>,
    build_sha: String,
    delta_flush_ms: u64,

    // ── Per-session state ────────────────────────────────────────────────
    journals: HashMap<SessionId, SessionJournal>,
    pending_deltas: HashMap<SessionId, PendingDelta>,
    swap_buffer: HashMap<SessionId, Vec<BufferedSwapEvent>>,
    swaps_in_flight: u32,

    // ── Cross-session tracking ────────────────────────────────────────────
    running: HashSet<SessionId>,
    initializing: HashSet<SessionId>,
    attention: HashMap<SessionId, AttentionRecord>,
    session_titles: HashMap<SessionId, String>,
    default_focus_id: Option<SessionId>,
    ever_connected: bool,
    session_list_dirty: bool,
    last_usage_emitted: HashMap<String, String>,

    // ── Desktop update state ──────────────────────────────────────────────
    update_sha: Option<String>,
    applying: bool,
    desktop_stale: bool,
    force_requested: bool,

    // ── Model cache ───────────────────────────────────────────────────────
    available_models: Vec<ModelOption>,

    // ── Prompt idempotency ledger ─────────────────────────────────────────
    prompt_results: HashMap<String, tokio::sync::oneshot::Receiver<()>>,

    // ── Epoch counter ─────────────────────────────────────────────────────
    epoch_counter: u64,
}

impl SessionHub {
    pub fn new(
        driver: Arc<dyn PilotDriver>,
        notify: Option<Arc<dyn Fn(HubNotification) + Send + Sync>>,
        live_refresh_ms: u64,
        server_id: String,
        data_dir: Option<PathBuf>,
        build_sha: String,
        delta_flush_ms: u64,
    ) -> Arc<Mutex<Self>> {
        let hub = Arc::new(Mutex::new(Self {
            driver,
            notify,
            live_refresh_ms,
            server_id,
            data_dir,
            build_sha,
            delta_flush_ms,
            journals: HashMap::new(),
            pending_deltas: HashMap::new(),
            swap_buffer: HashMap::new(),
            swaps_in_flight: 0,
            running: HashSet::new(),
            initializing: HashSet::new(),
            attention: HashMap::new(),
            session_titles: HashMap::new(),
            default_focus_id: None,
            ever_connected: false,
            session_list_dirty: true,
            last_usage_emitted: HashMap::new(),
            update_sha: None,
            applying: false,
            desktop_stale: false,
            force_requested: false,
            available_models: Vec::new(),
            prompt_results: HashMap::new(),
            epoch_counter: now_ms() as u64,
        }));

        // Seed the landing default
        {
            let mut h = hub.lock();
            h.seed_default();
        }

        hub
    }

    fn next_epoch(&mut self) -> u64 {
        self.epoch_counter += 1;
        self.epoch_counter
    }

    /// Establish the landing session a fresh client adopts.
    fn seed_default(&mut self) {
        if let Some(seed) = self.driver.default_seed() {
            if seed.is_empty() {
                return;
            }
            if let Some(sid) = seed.first().map(|e| e.session_ref().session_id.clone()) {
                for e in &seed {
                    let sid = e.session_ref().session_id.clone();
                    self.track_running(&sid, e);
                    self.track_attention(&sid, e);
                }
                let epoch = self.next_epoch();
                self.journals.insert(sid.clone(), create_journal(epoch, &seed));
                self.default_focus_id = Some(sid);
            }
        }
    }

    /// The seed source for one session: the journal's events, delta-coalesced,
    /// plus the {epoch, seq} watermark.
    pub fn seed_of(&self, sid: Option<&SessionId>) -> Option<(u64, u64, Vec<SessionDriverEvent>)> {
        let j = sid.and_then(|s| self.journals.get(s))?;
        Some(build_seed(j))
    }

    /// Fold one session's journal into its authoritative SessionState, on demand.
    pub fn folded_state(&self, sid: Option<&SessionId>) -> Option<SessionState> {
        let (_, _, events) = self.seed_of(sid)?;
        Some(fold_all(&events))
    }

    /// Build the seed message for one session.
    fn seed_msg(&self, sid: Option<&SessionId>) -> ServerMessage {
        match self.seed_of(sid) {
            Some((epoch, seq, events)) => ServerMessage::Seed {
                session_id: sid.cloned(),
                epoch,
                seq,
                events,
            },
            None => {
                if let Some(sid) = sid {
                    error!("[hub] no journal for session {sid} — sending an empty seed");
                }
                ServerMessage::Seed {
                    session_id: sid.cloned(),
                    epoch: 0,
                    seq: 0,
                    events: Vec::new(),
                }
            }
        }
    }

    /// The single immediate append path: stamp the journal, route to viewers.
    fn ingest_now(&mut self, ev: &SessionDriverEvent) {
        let sid = ev.session_ref().session_id.clone();

        if ev.type_discriminator() == "sessionReset" {
            // Transcript identity changed: restart the journal under a new epoch.
            // We need to: fold the old journal, compute the meta, then bump_epoch.
            // Split to avoid double-mutable-borrow of self.
            let old_events = {
                let Some(j) = self.journals.get(&sid) else {
                    return;
                };
                let (_, _, events) = build_seed(j);
                events
            };
            let mut st = fold_all(&old_events);
            fold_event(&mut st, ev);
            let meta = meta_seed_events(&st, &ev.session_ref(), &ev.timestamp());
            let epoch = self.next_epoch();
            if let Some(j) = self.journals.get_mut(&sid) {
                bump_epoch(j, epoch, &meta);
            }

            // Viewers get the fresh seed.
            let msg = self.seed_msg(Some(&sid));
            let focused: Vec<_> = self.clients_focused(&sid);
            for send in focused {
                let _ = send.try_send(msg.clone());
            }
            return;
        }

        let (seq, epoch) = {
            let Some(j) = self.journals.get_mut(&sid) else {
                return;
            };
            let seq = append_event(j, ev.clone());
            (seq, j.epoch)
        };
        let msg = ServerMessage::Event {
            event: ev.clone(),
            epoch,
            seq,
        };
        let focused: Vec<_> = self.clients_focused(&sid);
        for send in focused {
            let _ = send.try_send(msg.clone());
        }
    }

    /// The buffered append path (N1 coalescing). Every event enters the journal
    /// through here; assistantDeltas are coalesced per session behind the
    /// deltaFlushMs flush window.
    fn ingest(&mut self, ev: &SessionDriverEvent) {
        let sid = ev.session_ref().session_id.clone();
        if self.delta_flush_ms == 0 || !self.journals.contains_key(&sid) {
            self.ingest_now(ev);
            return;
        }
        if ev.type_discriminator() != "assistantDelta" {
            self.flush_pending(&sid);
            self.ingest_now(ev);
            return;
        }
        // Try to merge with existing pending delta
        if let Some(pending) = self.pending_deltas.get_mut(&sid) {
            if let Some(merged) = try_merge(&pending.ev, ev) {
                pending.ev = merged;
                return;
            }
            // Channel switch: flush the held run, start a new one
            self.flush_pending(&sid);
        }
        // Start a new pending run with a flush timer
        let (abort_tx, abort_rx) = tokio::sync::oneshot::channel();
        let _ = abort_rx; // would be awaited by the timer task
        self.pending_deltas.insert(
            sid.clone(),
            PendingDelta {
                ev: ev.clone(),
                timer_abort: abort_tx,
            },
        );
    }

    /// Commit one session's pending merged delta to the journal.
    fn flush_pending(&mut self, sid: &SessionId) {
        if let Some(pending) = self.pending_deltas.remove(sid) {
            let _ = pending.timer_abort.send(()); // abort the timer if armed
            self.ingest_now(&pending.ev);
        }
    }

    /// DROP one session's pending merged delta without committing it.
    fn drop_pending(&mut self, sid: &SessionId) {
        if let Some(pending) = self.pending_deltas.remove(sid) {
            let _ = pending.timer_abort.send(());
        }
    }

    /// Whether any connected client is currently focused on a session.
    fn has_viewer(&self, _sid: &SessionId) -> bool {
        // This is checked against client connections — in the Rust port, clients
        // are managed by the WS handler, so this is called from the hub context.
        // For now, we track this via the focused_id in ClientConn.
        // The actual client map lives in the hub's external state.
        false // will be wired when clients are managed
    }

    /// Get all send channels focused on a session.
    fn clients_focused(&self, _sid: &SessionId) -> Vec<mpsc::Sender<ServerMessage>> {
        // Clients are managed externally in the Rust port — this returns empty
        // until the client map is wired into the hub.
        Vec::new()
    }

    /// The main event ingestion path — called by the driver's event stream.
    pub fn on_event(&mut self, ev: SessionDriverEvent) {
        let sid = ev.session_ref().session_id.clone();

        // Cross-session tracking is GLOBAL
        let status_changed = self.track_running(&sid, &ev);
        let attention_changed = self.track_attention(&sid, &ev);
        if status_changed || attention_changed {
            self.broadcast_session_status();
        }

        // Mark session list dirty for events that change sidebar content
        let disc = ev.type_discriminator();
        if matches!(
            disc.as_str(),
            "userMessage" | "runCompleted" | "runFailed" | "sessionOpened" | "sessionClosed"
        ) {
            self.session_list_dirty = true;
        }

        // Attach-window race: buffer events for journal-less sessions during swaps
        if self.swaps_in_flight > 0 && !self.journals.contains_key(&sid) {
            self.buffer_swap_event(&sid, &ev);
        }

        // Journal + route for viewed sessions
        self.ingest(&ev);

        // Closed/evicted session drops its journal once nobody is viewing it
        if disc == "sessionClosed"
            && self.default_focus_id.as_ref() != Some(&sid)
            && !self.has_viewer(&sid)
        {
            self.drop_pending(&sid);
            self.journals.remove(&sid);
        }

        self.maybe_notify(&ev);
    }

    /// Buffer one attach-window event.
    fn buffer_swap_event(&mut self, sid: &SessionId, ev: &SessionDriverEvent) {
        let now = now_ms();
        // Prune stale entries
        let stale_keys: Vec<_> = self
            .swap_buffer
            .iter()
            .filter(|(_, list)| list.iter().all(|f| now - f.at_ms > SWAP_BUFFER_TTL_MS))
            .map(|(k, _)| k.clone())
            .collect();
        for k in stale_keys {
            self.swap_buffer.remove(&k);
        }

        let list = self.swap_buffer.entry(sid.clone()).or_default();
        if list.len() < SWAP_BUFFER_CAP {
            list.push(BufferedSwapEvent {
                at_ms: now,
                ev: ev.clone(),
            });
        }
    }

    /// Consume (and clear) the attach-window buffer for one session.
    fn take_swap_buffer(&mut self, sid: &SessionId, since: u128) -> Vec<SessionDriverEvent> {
        let Some(list) = self.swap_buffer.remove(sid) else {
            return Vec::new();
        };
        let now = now_ms();
        list.into_iter()
            .filter(|f| now - f.at_ms <= SWAP_BUFFER_TTL_MS && f.at_ms >= since)
            .map(|f| f.ev)
            .collect()
    }

    // ── Running/initializing tracking ──────────────────────────────────────

    /// Update the running set from one event and report whether it changed.
    fn track_running(&mut self, sid: &SessionId, ev: &SessionDriverEvent) -> bool {
        let before = self.running.contains(sid);
        let before_init = self.initializing.contains(sid);
        let disc = ev.type_discriminator();
        match disc.as_str() {
            "sessionOpened" | "sessionUpdated" | "runCompleted" => {
                let status = ev.snapshot_status();
                self.set_running(sid, status == Some(SessionStatus::Running));
                self.set_initializing(sid, status == Some(SessionStatus::Initializing));
            }
            "assistantDelta" | "toolStarted" | "toolUpdated" | "userMessage"
            | "queuedMessageStarted" => {
                self.set_running(sid, true);
            }
            "runFailed" | "sessionClosed" => {
                self.set_running(sid, false);
                self.set_initializing(sid, false);
            }
            _ => {}
        }
        self.running.contains(sid) != before || self.initializing.contains(sid) != before_init
    }

    fn set_running(&mut self, sid: &SessionId, on: bool) {
        if on {
            self.running.insert(sid.clone());
            self.initializing.remove(sid);
        } else {
            self.running.remove(sid);
        }
    }

    fn set_initializing(&mut self, sid: &SessionId, on: bool) {
        if on {
            self.initializing.insert(sid.clone());
            self.running.remove(sid);
        } else {
            self.initializing.remove(sid);
        }
    }

    // ── Attention tracking ────────────────────────────────────────────────

    fn attention_for(&self, sid: &SessionId) -> Option<SessionAttention> {
        let record = self.attention.get(sid)?;
        let pending: Vec<String> = record.pending.values().cloned().collect();
        if !pending.is_empty() {
            return Some(SessionAttention {
                session_id: sid.clone(),
                phase: SessionAttentionPhase::Waiting,
                activity: Some("Waiting on you".into()),
                pending_count: Some(pending.len() as i64),
                pending_title: Some(pending[0].clone()),
                updated_at: record.updated_at.clone(),
            });
        }
        Some(SessionAttention {
            session_id: sid.clone(),
            phase: match record.phase {
                AttentionPhase::Running => SessionAttentionPhase::Running,
                AttentionPhase::Failed => SessionAttentionPhase::Failed,
                AttentionPhase::Done => SessionAttentionPhase::Done,
            },
            activity: record.activity.clone(),
            pending_count: None,
            pending_title: None,
            updated_at: record.updated_at.clone(),
        })
    }

    fn track_attention(&mut self, sid: &SessionId, ev: &SessionDriverEvent) -> bool {
        let before = self
            .attention_for(sid)
            .map(|a| serde_json::to_string(&a).unwrap_or_default());

        let disc = ev.type_discriminator();
        let timestamp = ev.timestamp();

        match disc.as_str() {
            "sessionOpened" | "sessionUpdated" => {
                if let Some(title) = ev.snapshot_title() {
                    self.session_titles.insert(sid.clone(), title);
                }
                let status = ev.snapshot_status();
                match status {
                    Some(SessionStatus::Running) => self.set_attention_base(sid, AttentionPhase::Running, Some("Working"), &timestamp),
                    Some(SessionStatus::Initializing) => self.set_attention_base(sid, AttentionPhase::Running, Some("Starting session"), &timestamp),
                    Some(SessionStatus::Failed) => self.set_attention_base(sid, AttentionPhase::Failed, Some("Run failed"), &timestamp),
                    _ => {}
                }
            }
            "userMessage" => self.set_attention_base(sid, AttentionPhase::Running, Some("Starting"), &timestamp),
            "queuedMessageStarted" => self.set_attention_base(sid, AttentionPhase::Running, Some("Queued a follow-up"), &timestamp),
            "assistantDelta" => {
                let channel = ev.assistant_delta_channel();
                let activity = if channel.as_deref() == Some("thinking") {
                    "Thinking"
                } else {
                    "Responding"
                };
                self.set_attention_base(sid, AttentionPhase::Running, Some(activity), &timestamp);
            }
            "toolStarted" => {
                let activity = tool_activity(ev);
                self.set_attention_base(sid, AttentionPhase::Running, Some(&activity), &timestamp);
            }
            "toolFinished" => {
                if self.attention.get(sid).map(|r| r.phase == AttentionPhase::Running).unwrap_or(false) {
                    self.set_attention_base(sid, AttentionPhase::Running, Some("Working"), &timestamp);
                }
            }
            "runCompleted" => {
                if let Some(title) = ev.snapshot_title() {
                    self.session_titles.insert(sid.clone(), title);
                }
                self.set_attention_base(sid, AttentionPhase::Done, Some("Done"), &timestamp);
            }
            "runFailed" => {
                self.ensure_attention(sid, &timestamp);
                if let Some(record) = self.attention.get_mut(sid) {
                    record.pending.clear();
                }
                let msg = ev.error_message().unwrap_or_default();
                self.set_attention_base(sid, AttentionPhase::Failed, Some(&clipped(&msg, 72)), &timestamp);
            }
            "hostUiRequest" => {
                if let E::HostUiRequest { request, .. } = ev {
                    if is_dialog_request(request) {
                        let title = request_title(request);
                        self.ensure_attention(sid, &timestamp);
                        if let Some(record) = self.attention.get_mut(sid) {
                            record.pending.insert(request.request_id().to_string(), title);
                            record.updated_at = timestamp.clone();
                        }
                    } else if let HostUiRequest::Status { text, .. } = request {
                        if let Some(t) = text {
                            if self.attention.get(sid).map(|r| r.phase == AttentionPhase::Running).unwrap_or(false) {
                                self.set_attention_base(sid, AttentionPhase::Running, Some(&clipped(t, 72)), &timestamp);
                            }
                        }
                    } else if let HostUiRequest::Title { title, .. } = request {
                        self.session_titles.insert(sid.clone(), title.clone());
                    }
                }
            }
            "hostUiResolved" => {
                if let E::HostUiResolved { request_id, .. } = ev {
                    if let Some(record) = self.attention.get_mut(sid) {
                        if record.pending.remove(request_id).is_some() {
                            record.updated_at = timestamp.clone();
                        }
                    }
                }
            }
            "sessionClosed" => {
                self.attention.remove(sid);
                self.session_titles.remove(sid);
            }
            _ => {}
        }

        let after = self
            .attention_for(sid)
            .map(|a| serde_json::to_string(&a).unwrap_or_default());
        before != after
    }

    fn ensure_attention(&mut self, sid: &SessionId, timestamp: &str) {
        if !self.attention.contains_key(sid) {
            self.attention.insert(
                sid.clone(),
                AttentionRecord {
                    phase: AttentionPhase::Running,
                    activity: Some("Working".into()),
                    updated_at: timestamp.into(),
                    pending: HashMap::new(),
                },
            );
        }
    }

    fn set_attention_base(&mut self, sid: &SessionId, phase: AttentionPhase, activity: Option<&str>, timestamp: &str) {
        self.ensure_attention(sid, timestamp);
        if let Some(record) = self.attention.get_mut(sid) {
            let changed = record.phase != phase || record.activity.as_deref() != activity;
            record.phase = phase;
            record.activity = activity.map(|s| s.to_string());
            if changed {
                record.updated_at = timestamp.into();
            }
        }
    }

    // ── Session status broadcast ──────────────────────────────────────────

    fn session_status_msg(&self) -> ServerMessage {
        let attention: Vec<SessionAttention> = self
            .attention
            .keys()
            .filter_map(|sid| self.attention_for(sid))
            .collect();
        ServerMessage::SessionStatus {
            running_ids: self.running.iter().cloned().collect(),
            initializing_ids: Some(self.initializing.iter().cloned().collect()),
            attention: Some(attention),
        }
    }

    fn broadcast_session_status(&mut self) {
        // Will be wired to the client send channels when clients are managed
        // by the hub. For now this is a no-op that will be filled in.
        // The syncLiveRefresh logic also needs the client count.
    }

    // ── Notification ───────────────────────────────────────────────────────

    fn maybe_notify(&self, ev: &SessionDriverEvent) {
        let Some(notify) = &self.notify else { return };
        // Push only when someone has been here and then left
        if self.ever_connected && self.client_count() == 0 {
            let sid = ev.session_ref().session_id.clone();
            let session = self.session_titles.get(&sid).cloned().unwrap_or_else(|| sid.clone());
            let url = format!("/?session={}", urlencoding::encode(&sid));
            let disc = ev.type_discriminator();
            if disc == "runCompleted" {
                notify(HubNotification {
                    title: "pilot".into(),
                    body: format!("{session} finished its turn"),
                    tag: Some(format!("pilot-run-{sid}")),
                    url: Some(url),
                });
            } else if disc == "runFailed" {
                let msg = ev.error_message().unwrap_or_default();
                notify(HubNotification {
                    title: "pilot".into(),
                    body: format!("{session} failed: {}", clipped(&msg, 72)),
                    tag: Some(format!("pilot-run-{sid}")),
                    url: Some(url),
                });
            } else if disc == "hostUiRequest" {
                if let E::HostUiRequest { request, .. } = ev {
                    let kind = request.kind();
                    if matches!(kind, "confirm" | "select" | "input" | "editor" | "qna") {
                        let title = request.title().unwrap_or("Waiting on you");
                        notify(HubNotification {
                            title: "Approval needed".into(),
                            body: format!("{session}: {title}"),
                            tag: Some(format!("pilot-approval-{sid}")),
                            url: Some(url),
                        });
                    }
                }
            }
        }
    }

    // ── Public API ────────────────────────────────────────────────────────

    pub fn client_count(&self) -> usize {
        // Will be wired when client management is in the hub
        0
    }

    pub fn snapshot(&self) -> serde_json::Value {
        // Fold the default session's journal for /debug/state
        let sid = self.default_focus_id.as_ref();
        match self.folded_state(sid) {
            Some(state) => serde_json::to_value(&state).unwrap_or(serde_json::json!({})),
            None => serde_json::json!({}),
        }
    }

    pub fn activity(&self) -> serde_json::Value {
        serde_json::json!({
            "running": self.running.len(),
            "initializing": self.initializing.len(),
            "busy": self.running.len() > 0 || self.initializing.len() > 0,
        })
    }

    pub fn report_update(
        &mut self,
        sha: Option<String>,
        apply_failed: bool,
        desktop_stale: Option<bool>,
    ) -> serde_json::Value {
        self.update_sha = sha;
        if apply_failed {
            self.applying = false;
        }
        if let Some(stale) = desktop_stale {
            self.desktop_stale = stale;
        }
        let force = self.force_requested;
        self.force_requested = false;
        serde_json::json!({
            "applying": self.applying,
            "force": force,
        })
    }

    pub fn reset(&mut self, bootstrap: bool) {
        // Clear all state
        self.journals.clear();
        self.pending_deltas.clear();
        self.swap_buffer.clear();
        self.running.clear();
        self.initializing.clear();
        self.attention.clear();
        self.session_titles.clear();
        self.last_usage_emitted.clear();
        self.default_focus_id = None;
        self.session_list_dirty = true;
        self.swaps_in_flight = 0;

        self.driver.reset(bootstrap);
        if bootstrap {
            self.seed_default();
        }
    }
}

// ── Free functions (port of hub.ts helpers) ─────────────────────────────

/// Coerce a caught value into a human-readable string.
pub fn err_msg(e: &dyn std::error::Error) -> String {
    e.to_string()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn clipped(value: &str, max: usize) -> String {
    let one_line: String = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.len() > max {
        format!("{}…", &one_line[..max.saturating_sub(1)])
    } else {
        one_line
    }
}

/// Generate a human-readable activity string for a tool event.
fn tool_activity(ev: &SessionDriverEvent) -> String {
    if let E::ToolStarted {
        tool_name,
        input,
        label,
        description,
        ..
    } = ev
    {
        let name = tool_name.to_lowercase();
        let path = input_string(input, &["path", "filePath", "file_path"]);
        if name.contains("read") {
            return path.map(|p| format!("Reading {p}")).unwrap_or_else(|| "Reading files".into());
        }
        if name.contains("edit") || name.contains("write") {
            return path.map(|p| format!("Editing {p}")).unwrap_or_else(|| "Editing files".into());
        }
        if name.contains("search") || name.contains("grep") || name == "rg" {
            return "Searching the workspace".into();
        }
        if name == "bash" || name == "shell" || name == "exec" {
            let command = input_string(input, &["command", "cmd"]);
            return command.map(|c| format!("Running {c}")).unwrap_or_else(|| "Running a command".into());
        }
        return clipped(
            &label
                .as_deref()
                .or(description.as_deref())
                .unwrap_or(tool_name),
            72,
        );
    }
    "Working".into()
}

fn input_string(input: &Option<serde_json::Value>, keys: &[&str]) -> Option<String> {
    let obj = input.as_ref()?.as_object()?;
    for key in keys {
        if let Some(value) = obj.get(*key) {
            if let Some(s) = value.as_str() {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    return Some(clipped(trimmed, 72));
                }
            }
        }
    }
    None
}

fn request_title(request: &HostUiRequest) -> String {
    if let Some(title) = request.title() {
        if !title.is_empty() {
            return clipped(title, 72);
        }
    }
    if let Some(msg) = request.message() {
        if !msg.is_empty() {
            return clipped(msg, 72);
        }
    }
    if request.kind() == "qna" {
        "Questions need answers".into()
    } else {
        "Waiting on you".into()
    }
}

fn is_dialog_request(request: &HostUiRequest) -> bool {
    matches!(
        request.kind(),
        "confirm" | "select" | "input" | "editor" | "qna" | "permission"
    )
}

// ── Trait extensions for ergonomic access to SessionDriverEvent fields ───

/// Helper trait to access common fields on SessionDriverEvent without
/// destructuring every variant.
trait SessionDriverEventExt {
    fn session_ref(&self) -> &SessionRef;
    fn timestamp(&self) -> &str;
    fn type_discriminator(&self) -> String;
    fn snapshot_status(&self) -> Option<SessionStatus>;
    fn snapshot_title(&self) -> Option<String>;
    fn assistant_delta_channel(&self) -> Option<String>;
    fn error_message(&self) -> Option<String>;
}

impl SessionDriverEventExt for SessionDriverEvent {
    fn session_ref(&self) -> &SessionRef {
        match self {
            E::SessionOpened { base, .. } => &base.session_ref,
            E::SessionUpdated { base, .. } => &base.session_ref,
            E::SessionClosed { base, .. } => &base.session_ref,
            E::AssistantDelta { base, .. } => &base.session_ref,
            E::ToolStarted { base, .. } => &base.session_ref,
            E::ToolUpdated { base, .. } => &base.session_ref,
            E::ToolFinished { base, .. } => &base.session_ref,
            E::UserMessage { base, .. } => &base.session_ref,
            E::RunCompleted { base, .. } => &base.session_ref,
            E::RunFailed { base, .. } => &base.session_ref,
            E::UsageUpdated { base, .. } => &base.session_ref,
            E::HostUiRequest { base, .. } => &base.session_ref,
            E::HostUiResolved { base, .. } => &base.session_ref,
            E::QueueUpdated { base, .. } => &base.session_ref,
            E::QueuedMessageStarted { base, .. } => &base.session_ref,
            E::CustomMessage { base, .. } => &base.session_ref,
            E::ExtensionCompatibilityIssue { base, .. } => &base.session_ref,
            E::SessionReset { base, .. } => &base.session_ref,
        }
    }

    fn timestamp(&self) -> &str {
        match self {
            E::SessionOpened { base, .. } => &base.timestamp,
            E::SessionUpdated { base, .. } => &base.timestamp,
            E::SessionClosed { base, .. } => &base.timestamp,
            E::AssistantDelta { base, .. } => &base.timestamp,
            E::ToolStarted { base, .. } => &base.timestamp,
            E::ToolUpdated { base, .. } => &base.timestamp,
            E::ToolFinished { base, .. } => &base.timestamp,
            E::UserMessage { base, .. } => &base.timestamp,
            E::RunCompleted { base, .. } => &base.timestamp,
            E::RunFailed { base, .. } => &base.timestamp,
            E::UsageUpdated { base, .. } => &base.timestamp,
            E::HostUiRequest { base, .. } => &base.timestamp,
            E::HostUiResolved { base, .. } => &base.timestamp,
            E::QueueUpdated { base, .. } => &base.timestamp,
            E::QueuedMessageStarted { base, .. } => &base.timestamp,
            E::CustomMessage { base, .. } => &base.timestamp,
            E::ExtensionCompatibilityIssue { base, .. } => &base.timestamp,
            E::SessionReset { base, .. } => &base.timestamp,
        }
    }

    fn type_discriminator(&self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|s| s.to_string()))
            .unwrap_or_default()
    }

    fn snapshot_status(&self) -> Option<SessionStatus> {
        match self {
            E::SessionOpened { snapshot, .. } | E::SessionUpdated { snapshot, .. } | E::RunCompleted { snapshot, .. } => Some(snapshot.status),
            _ => None,
        }
    }

    fn snapshot_title(&self) -> Option<String> {
        match self {
            E::SessionOpened { snapshot, .. } | E::SessionUpdated { snapshot, .. } | E::RunCompleted { snapshot, .. } => Some(snapshot.title.clone()),
            _ => None,
        }
    }

    fn assistant_delta_channel(&self) -> Option<String> {
        match self {
            E::AssistantDelta { channel, .. } => channel.as_ref().map(|c| serde_json::to_value(c).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()),
            _ => None,
        }
    }

    fn error_message(&self) -> Option<String> {
        match self {
            E::RunFailed { error, .. } => Some(error.message.clone()),
            _ => None,
        }
    }
}

/// Helper trait for accessing HostUiRequest fields.
trait HostUiRequestExt {
    fn kind(&self) -> &str;
    fn request_id(&self) -> &str;
    fn title(&self) -> Option<&str>;
    fn message(&self) -> Option<&str>;
}

impl HostUiRequestExt for HostUiRequest {
    fn kind(&self) -> &str {
        match self {
            HostUiRequest::Confirm { .. } => "confirm",
            HostUiRequest::Select { .. } => "select",
            HostUiRequest::Input { .. } => "input",
            HostUiRequest::Editor { .. } => "editor",
            HostUiRequest::Qna { .. } => "qna",
            HostUiRequest::Permission { .. } => "permission",
            HostUiRequest::Plan { .. } => "planHandoff",
            HostUiRequest::Notify { .. } => "notify",
            HostUiRequest::Status { .. } => "status",
            HostUiRequest::Widget { .. } => "widget",
            HostUiRequest::Title { .. } => "title",
            HostUiRequest::EditorText { .. } => "editorText",
            HostUiRequest::Reset { .. } => "reset",
        }
    }

    fn request_id(&self) -> &str {
        match self {
            HostUiRequest::Confirm { request_id, .. } => request_id,
            HostUiRequest::Select { request_id, .. } => request_id,
            HostUiRequest::Input { request_id, .. } => request_id,
            HostUiRequest::Editor { request_id, .. } => request_id,
            HostUiRequest::Qna { request_id, .. } => request_id,
            HostUiRequest::Permission { request_id, .. } => request_id,
            HostUiRequest::Plan { request_id, .. } => request_id,
            HostUiRequest::Notify { request_id, .. } => request_id,
            HostUiRequest::Status { request_id, .. } => request_id,
            HostUiRequest::Widget { request_id, .. } => request_id,
            HostUiRequest::Title { request_id, .. } => request_id,
            HostUiRequest::EditorText { request_id, .. } => request_id,
            HostUiRequest::Reset { request_id, .. } => request_id,
        }
    }

    fn title(&self) -> Option<&str> {
        match self {
            HostUiRequest::Confirm { title, .. } => Some(title),
            HostUiRequest::Select { title, .. } => Some(title),
            HostUiRequest::Editor { title, .. } => Some(title),
            HostUiRequest::Qna { title, .. } => title.as_deref(),
            HostUiRequest::Permission { title, .. } => Some(title),
            HostUiRequest::Plan { title, .. } => Some(title),
            HostUiRequest::Title { title, .. } => Some(title),
            _ => None,
        }
    }

    fn message(&self) -> Option<&str> {
        match self {
            HostUiRequest::Confirm { message, .. } => Some(message),
            HostUiRequest::Notify { message, .. } => Some(message),
            _ => None,
        }
    }
}
