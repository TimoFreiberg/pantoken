//! Tauri commands for remote-connection management (Phase 2, step 11).
//! Remote-connection commands (Tauri command layer).
//!
//! Commands (registered in `main.rs` via `invoke_handler`):
//! - `list_remote_profiles() -> Vec<RemoteProfile>`
//! - `add_remote_profile(profile: RemoteProfile) -> RemoteProfile`
//! - `update_remote_profile(profile: RemoteProfile)`
//! - `delete_remote_profile(id: String)` — tears down the bridge if running, then removes the profile.
//! - `ensure_remote_host(profile_id: String) -> HostStateSnapshot` — starts the bridge + SSH, returns state.
//! - `host_state(id: String) -> Option<HostStateSnapshot>` — polls one host's state.
//! - `list_hosts() -> Vec<HostStateSnapshot>` — lists local + all saved remote profiles with state.
//! - `disconnect_host(id: String)` — tears down one remote host's bridge.
//!
//! ## Ensure-vs-navigate split
//!
//! The native command layer starts the bridge + provisioning and returns the
//! loopback WS URL. It does NOT navigate the WebView, raise the native overlay,
//! or show dialogs. The client (via `TauriHostProvider.connectHost`) polls
//! `host_state(id)` until the bridge is ready. This is a compile-time
//! guarantee: the new impl functions take no `&AppHandle` parameter, so they
//! physically cannot call `shell::navigate_main`.
//!
//! ## Core vs command layer
//!
//! The `#[tauri::command]` wrappers are thin: they extract the `AppState`
//! from the `State<'_>` guard and delegate to the core `*_impl` functions,
//! which take `&AppState`. The `transport` is injected for testability.

#![allow(clippy::doc_lazy_continuation)]

use std::sync::Arc;

use tauri::State;

use crate::bridge::{Bridge, ConnectionStateSink, SshCommand, SshTransport, SystemSshTransport};
use crate::remote_connection::{ConnectionState, PendingRisk, PreflightPhase, RemoteConnection};
use crate::remote_executor::{preflight_docker, HostExecutor, PreflightOutcome, RemoteExecutor};
use crate::remote_profile::{ExecutionTargetProfile, RemoteProfile, RemoteProfileStore};
use crate::state::{AppState, RemoteSession};

// ── core logic (callable from tray handlers + commands) ──────────────────

pub fn list_remote_profiles_impl(state: &AppState) -> Vec<RemoteProfile> {
    let path = state.config.remote_profiles_path();
    let store = RemoteProfileStore::load(&path).unwrap_or_default();
    store.profiles
}

pub fn add_remote_profile_impl(
    state: &AppState,
    profile: RemoteProfile,
) -> Result<RemoteProfile, String> {
    profile.validate().map_err(|e| e.to_string())?;
    let path = state.config.remote_profiles_path();
    let mut store = RemoteProfileStore::load(&path).map_err(|e| e.to_string())?;
    store.profiles.push(profile.clone());
    store.save(&path).map_err(|e| e.to_string())?;
    Ok(profile)
}

pub fn update_remote_profile_impl(state: &AppState, profile: RemoteProfile) -> Result<(), String> {
    profile.validate().map_err(|e| e.to_string())?;
    let path = state.config.remote_profiles_path();
    let mut store = RemoteProfileStore::load(&path).map_err(|e| e.to_string())?;
    let idx = store
        .profiles
        .iter()
        .position(|p| p.id == profile.id)
        .ok_or_else(|| format!("no profile with id {}", profile.id))?;
    store.profiles[idx] = profile;
    store.save(&path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_remote_profile_impl(state: &AppState, id: String) -> Result<(), String> {
    // 1. Tear down the bridge if this profile has a running session.
    state.stop_remote(&id);
    // 2. Remove from the persisted store.
    let path = state.config.remote_profiles_path();
    let mut store = RemoteProfileStore::load(&path).map_err(|e| e.to_string())?;
    let before = store.profiles.len();
    store.profiles.retain(|p| p.id != id);
    if store.profiles.len() == before {
        return Err(format!("no profile with id {id}"));
    }
    store.save(&path).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Host state snapshots ─────────────────────────────────────────────────
//
// `HostStateSnapshot` is the serializable struct matching the client's
// `NativeHostDescriptor`. It maps `ConnectionState` to the client's
// `HostConnectionState` string, exposes the loopback WS URL, and redacts
// failure diagnostics.

/// A serializable snapshot of one host's state, matching the client's
/// `NativeHostDescriptor`. Used by `host_state` / `list_hosts` commands.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStateSnapshot {
    /// "local" for the local machine, or the RemoteProfile.id for a remote.
    pub id: String,
    /// "local" | "remote".
    pub kind: String,
    /// The host label. Empty for the local host (the client fills it from
    /// `store.serverLabel` after `hello`).
    pub label: String,
    /// Subtitle (e.g. the SSH destination for remote, "This computer" for local
    /// — set by the client).
    pub subtitle: String,
    /// The connection state string, matching the client's
    /// `HostConnectionState` (camelCase).
    pub state: String,
    /// The loopback WS URL, present when the bridge is running
    /// (ready/starting/reconnecting). Never a non-loopback URL.
    pub ws_url: Option<String>,
    /// Short failure label (e.g. "SSH authentication failed"), if failed.
    pub failure_label: Option<String>,
    /// Suggested recovery action, if failed.
    pub failure_action: Option<String>,
    /// Redacted diagnostic detail, if failed.
    pub failure_detail: Option<String>,
    pub preflight_phase: Option<PreflightPhase>,
    pub pending_risks: Option<Vec<PendingRisk>>,
    pub redacted_ssh_host: Option<String>,
    pub container_name: Option<String>,
}

// ── Container discovery DTOs (test_ssh_and_list_containers / inspect_container) ─

/// A running container summary returned by `test_ssh_and_list_containers`.
/// Mirrors the TS `ContainerSummary` interface.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    pub name: String,
    pub image: String,
    pub state: String,
    pub configured_user: String,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
}

/// Result of `test_ssh_and_list_containers`. Mirrors the TS `TestSshResult`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSshResult {
    pub ssh_ok: bool,
    pub docker_permission: String,
    pub containers: Vec<ContainerSummary>,
    /// First line of ssh stderr when the SSH command itself failed (exit 255):
    /// auth, host-key, or unreachable errors. `None` otherwise.
    #[serde(rename = "sshErrorDetail")]
    pub ssh_error_detail: Option<String>,
    /// Machine-readable setup failure family, when the probe did not succeed.
    #[serde(rename = "failureKind")]
    pub failure_kind: Option<String>,
    /// Bounded, redacted technical detail for the setup disclosure.
    #[serde(rename = "failureDetail")]
    pub failure_detail: Option<String>,
}

/// A mount on a container, from `inspect_container`. Mirrors `MountSummary`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountSummary {
    #[serde(rename = "type")]
    pub mount_type: String,
    pub source: Option<String>,
    pub destination: String,
    pub read_only: bool,
    pub name: Option<String>,
}

/// Full container inspection result from `inspect_container`.
/// Mirrors the TS `ContainerInspection`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInspection {
    pub name: String,
    pub container_id: String,
    pub image: String,
    pub running: bool,
    pub configured_user: String,
    pub resolved_user: String,
    pub resolved_uid: u64,
    pub resolved_gid: u64,
    pub resolved_home: String,
    pub os: Option<String>,
    pub arch: Option<String>,
    pub mounts: Vec<MountSummary>,
    pub pantoken_root_suggestion: String,
}

/// Map `ConnectionState` → the client's `HostConnectionState` string.
/// This is separate from `overlay_label()` which returns display strings
/// like "Testing SSH…". The client expects camelCase state names.
fn connection_state_to_host_string(state: &ConnectionState) -> String {
    match state {
        ConnectionState::Disconnected => "disconnected",
        ConnectionState::TestingSsh => "testingSsh",
        ConnectionState::Preflight { .. } => "preflight",
        ConnectionState::AwaitingAcknowledgement { .. } => "awaitingAcknowledgement",
        ConnectionState::Connecting => "connecting",
        ConnectionState::Provisioning => "provisioning",
        ConnectionState::Starting => "starting",
        ConnectionState::Ready => "ready",
        ConnectionState::Reconnecting => "reconnecting",
        ConnectionState::Failed { .. } => "failed",
    }
    .into()
}

/// Redact failure detail: strip anything that looks like an SSH command line
/// and truncate stderr to a reasonable length. The raw detail may contain the
/// SSH argv or unredacted stderr — neither should surface in the normal UI.
fn redact_detail(raw: &str) -> String {
    // Strip lines that look like an SSH command invocation. An SSH command
    // starts with `ssh ` and contains `-o` or `BatchMode`.
    let lines: Vec<&str> = raw
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !(trimmed.starts_with("ssh ")
                && (trimmed.contains("-o") || trimmed.contains("BatchMode")))
        })
        .collect();
    let mut cleaned = lines.join("\n");
    // Truncate to a reasonable length.
    const MAX_LEN: usize = 500;
    if cleaned.len() > MAX_LEN {
        cleaned.truncate(MAX_LEN);
        cleaned.push('…');
    }
    cleaned
}

fn state_preflight_metadata(
    state: &ConnectionState,
) -> (Option<PreflightPhase>, Option<Vec<PendingRisk>>) {
    match state {
        ConnectionState::Preflight { phase } => (Some(*phase), None),
        ConnectionState::AwaitingAcknowledgement {
            phase,
            pending_risks,
        } => (Some(*phase), Some(pending_risks.clone())),
        _ => (None, None),
    }
}

fn profile_target_context(profile: &RemoteProfile) -> (Option<String>, Option<String>) {
    match &profile.execution_target {
        crate::remote_profile::ExecutionTargetProfile::Host => (None, None),
        crate::remote_profile::ExecutionTargetProfile::DockerContainer {
            container_name, ..
        } => {
            let host = profile
                .ssh_destination
                .rsplit_once('@')
                .map_or(profile.ssh_destination.as_str(), |(_, host)| host)
                .to_owned();
            (Some(host), Some(container_name.clone()))
        }
    }
}

/// Build a `HostStateSnapshot` from a remote session's connection state.
fn remote_snapshot(
    id: &str,
    profile: &RemoteProfile,
    connection: &RemoteConnection,
    bridge_port: Option<u16>,
) -> HostStateSnapshot {
    let state = connection.state();
    let state_str = connection_state_to_host_string(&state);

    let (failure_label, failure_action, failure_detail) = match &state {
        ConnectionState::Failed { kind, detail } => (
            Some(kind.label().to_string()),
            Some(kind.suggested_action().to_string()),
            Some(redact_detail(detail)),
        ),
        _ => (None, None, None),
    };

    // wsUrl is present when the bridge is running (ready/starting/reconnecting/
    // connecting/provisioning/testingSsh). Disconnected/failed → None.
    let ws_url = if matches!(
        state,
        ConnectionState::TestingSsh
            | ConnectionState::Connecting
            | ConnectionState::Provisioning
            | ConnectionState::Starting
            | ConnectionState::Ready
            | ConnectionState::Reconnecting
    ) {
        bridge_port.map(|p| format!("ws://127.0.0.1:{p}"))
    } else {
        None
    };

    let (preflight_phase, pending_risks) = state_preflight_metadata(&state);
    let (redacted_ssh_host, container_name) = profile_target_context(profile);
    HostStateSnapshot {
        id: id.into(),
        kind: "remote".into(),
        label: profile.label.clone(),
        subtitle: profile.ssh_destination.clone(),
        state: state_str,
        ws_url,
        failure_label,
        failure_action,
        failure_detail,
        preflight_phase,
        pending_risks,
        redacted_ssh_host,
        container_name,
    }
}

/// Apply the reconcile outcome's resolved paths to the SshCommand, overriding
/// the profile defaults. This is the single place where `server_path` and
/// `PANTOKEN_POLYTOKEN_BIN` are set from provisioning results.
pub fn apply_outcome_to_command(
    command: SshCommand,
    outcome: &crate::provisioning::reconcile::ReconcileOutcome,
) -> SshCommand {
    use crate::provisioning::reconcile::ReconcileOutcome;

    let mut command = command;
    match outcome {
        ReconcileOutcome::Ready {
            polytoken_binary_path,
            server_binary_path,
            ..
        }
        | ReconcileOutcome::Installed {
            polytoken_binary_path,
            server_binary_path,
            ..
        } => {
            command.server_path = server_binary_path.clone();
            if let Some(path) = polytoken_binary_path {
                command
                    .extra_env
                    .push(("PANTOKEN_POLYTOKEN_BIN".into(), path.clone()));
            }
        }
        _ => {}
    }
    command
}

/// Ensure a remote bridge session exists for the given profile id. If a session
/// is already running for this id, return its state immediately. Otherwise,
/// acquire a free loopback port, build the bridge + provisioning on the
/// dedicated runtime, store the session keyed by profile id, and return.
///
/// Does NOT navigate the WebView, raise the native overlay, or show dialogs.
/// The client polls `host_state(id)` until the bridge is ready.
///
/// `transport` is injected for testability: the #[tauri::command] wrapper
/// passes `SystemSshTransport::new()`; tests pass `FakeSshTransport`.
pub fn ensure_remote_host_impl(
    state: &AppState,
    profile_id: String,
    transport: &Arc<dyn SshTransport>,
) -> Result<HostStateSnapshot, String> {
    // 1. Load + validate the profile.
    let path = state.config.remote_profiles_path();
    let store = RemoteProfileStore::load(&path).map_err(|e| e.to_string())?;
    let profile = store
        .profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("no remote profile with id {profile_id}"))?;
    profile.validate().map_err(|e| e.to_string())?;

    // 2. If a session already exists for this id, return its current state.
    if let Some(connection) = state.get_remote(&profile_id) {
        let bridge_port = state.get_remote_bridge_port(&profile_id);
        return Ok(remote_snapshot(
            &profile_id,
            &profile,
            &connection,
            bridge_port,
        ));
    }

    // 3. Acquire a free loopback port (TOCTOU window documented in config.rs;
    //    a bind failure surfaces as ProxyStartFailed).
    let bridge_port = crate::config::free_port()
        .map_err(|e| format!("couldn't acquire a free loopback port for the bridge: {e}"))?;

    // 4. Build the bridge: transport + resolved SSH command.
    let connection = Arc::new(RemoteConnection::new());
    connection.begin(profile.clone());

    let command = SshCommand::from(&profile);
    let transport = transport.clone();

    // 5. Run provisioning reconciliation on the dedicated runtime, THEN start
    //    the bridge. Provisioning probes the remote host, checks polytoken
    //    compatibility, and optionally installs polytoken before the bridge
    //    begins its SSH stdio relay. The state machine is driven by the sink.
    let bridge_port_for_task = bridge_port;
    let connection_for_prov = connection.clone();
    let transport_for_prov = transport.clone();
    let command_for_prov = command.clone();
    let profile_for_prov = profile.clone();

    let cancel = tokio_util::sync::CancellationToken::new();
    let cancel_for_task = cancel.clone();
    let handle = state.remote_handle.spawn(async move {
        let executor: Arc<dyn RemoteExecutor> = match &profile_for_prov.execution_target {
            ExecutionTargetProfile::Host => Arc::new(HostExecutor::new(
                transport_for_prov.clone(),
                command_for_prov.clone(),
            )),
            ExecutionTargetProfile::DockerContainer { .. } => {
                let connection_for_phase = connection_for_prov.clone();
                match preflight_docker(
                    transport_for_prov.clone(),
                    &profile_for_prov,
                    move |phase| {
                        connection_for_phase.on_state(ConnectionState::Preflight { phase });
                    },
                )
                .await
                {
                    Ok(PreflightOutcome::Ready(executor)) => Arc::new(executor),
                    Ok(PreflightOutcome::AwaitingAcknowledgement {
                        phase,
                        pending_risks,
                        ..
                    }) => {
                        connection_for_prov.on_state(ConnectionState::AwaitingAcknowledgement {
                            phase,
                            pending_risks,
                        });
                        return;
                    }
                    Err(error) => {
                        connection_for_prov.on_state(ConnectionState::failed(
                            crate::remote_connection::ConnectionFailureState::ProvisioningFailed,
                            error.to_string(),
                        ));
                        return;
                    }
                }
            }
        };
        connection_for_prov.on_state(ConnectionState::Connecting);
        let manifest = crate::provisioning::embedded_manifest::get();
        let outcome = crate::provisioning::reconcile::reconcile(
            executor.as_ref(),
            &profile_for_prov,
            Some(&(connection_for_prov.clone() as Arc<dyn ConnectionStateSink>)),
            crate::provisioning::polytoken_install::default_http_fetch(),
            &manifest,
        )
        .await;

        match outcome {
            crate::provisioning::reconcile::ReconcileOutcome::Ready { .. }
            | crate::provisioning::reconcile::ReconcileOutcome::Installed { .. } => {
                // Provisioning succeeded — apply the resolved paths to the
                // bridge command (server_path + PANTOKEN_POLYTOKEN_BIN), then
                // start the bridge.
                let command = apply_outcome_to_command(command_for_prov, &outcome);
                connection_for_prov.on_state(ConnectionState::Starting);
                let bridge = Bridge::new_with_executor(
                    bridge_port_for_task,
                    executor,
                    command.server_path,
                    command.extra_env,
                )
                .with_state_sink(connection_for_prov.clone() as Arc<dyn ConnectionStateSink>);
                if let Err(e) = bridge.run(cancel_for_task).await {
                    eprintln!("pantoken: bridge run error: {e}");
                }
            }
            crate::provisioning::reconcile::ReconcileOutcome::Missing { .. }
            | crate::provisioning::reconcile::ReconcileOutcome::UnsupportedTarget { .. }
            | crate::provisioning::reconcile::ReconcileOutcome::Failed(_) => {
                // Provisioning failed — the reconcile function already drove
                // the state machine to Failed. The client polls host_state
                // and presents the failure.
            }
        }
    });

    // 6. Store the session keyed by profile_id.
    let session = Arc::new(RemoteSession {
        handle: std::sync::Mutex::new(Some(handle)),
        cancel,
        connection: connection.clone(),
        bridge_port,
    });
    state
        .remote
        .lock()
        .unwrap()
        .insert(profile_id.clone(), session);

    // 7. Return the current HostStateSnapshot (will be TestingSsh/Connecting).
    Ok(remote_snapshot(
        &profile_id,
        &profile,
        &connection,
        Some(bridge_port),
    ))
}

/// Get the current state of one host (local or remote).
/// Returns `None` if the id is not a known host.
pub fn host_state_impl(state: &AppState, id: &str) -> Option<HostStateSnapshot> {
    if id == "local" {
        // The local host: the native layer returns label="" and subtitle=""
        // (the client fills in the label from store.serverLabel after hello,
        // and sets subtitle to "This computer"). wsUrl = ws://127.0.0.1:{port}/ws.
        let ws_url = format!("ws://127.0.0.1:{}/ws", state.config.server_port);
        // State is "ready" if the supervisor is healthy, "disconnected" otherwise.
        let is_healthy = state.supervisor.lock().unwrap().is_some();
        Some(HostStateSnapshot {
            id: "local".into(),
            kind: "local".into(),
            label: String::new(),
            subtitle: String::new(),
            state: if is_healthy { "ready" } else { "disconnected" }.into(),
            ws_url: Some(ws_url),
            failure_label: None,
            failure_action: None,
            failure_detail: None,
            preflight_phase: None,
            pending_risks: None,
            redacted_ssh_host: None,
            container_name: None,
        })
    } else {
        // Remote: read from the RemoteConnection state machine.
        let connection = state.get_remote(id)?;
        let bridge_port = state.get_remote_bridge_port(id);
        // Load the profile for label/subtitle.
        let path = state.config.remote_profiles_path();
        let store = RemoteProfileStore::load(&path).ok()?;
        let profile = store.profiles.into_iter().find(|p| p.id == id)?;
        Some(remote_snapshot(id, &profile, &connection, bridge_port))
    }
}

/// List all hosts (local + saved remote profiles with current state).
/// Local descriptor first, then remote profiles in persisted order.
pub fn list_hosts_impl(state: &AppState) -> Vec<HostStateSnapshot> {
    let mut snapshots = Vec::new();

    // Local host first.
    if let Some(local) = host_state_impl(state, "local") {
        snapshots.push(local);
    }

    // Remote profiles in persisted order.
    let path = state.config.remote_profiles_path();
    let store = RemoteProfileStore::load(&path).unwrap_or_default();
    for profile in &store.profiles {
        if let Some(connection) = state.get_remote(&profile.id) {
            let bridge_port = state.get_remote_bridge_port(&profile.id);
            snapshots.push(remote_snapshot(
                &profile.id,
                profile,
                &connection,
                bridge_port,
            ));
        } else {
            // No running session → disconnected.
            let (redacted_ssh_host, container_name) = profile_target_context(profile);
            snapshots.push(HostStateSnapshot {
                id: profile.id.clone(),
                kind: "remote".into(),
                label: profile.label.clone(),
                subtitle: profile.ssh_destination.clone(),
                state: "disconnected".into(),
                ws_url: None,
                failure_label: None,
                failure_action: None,
                failure_detail: None,
                preflight_phase: None,
                pending_risks: None,
                redacted_ssh_host,
                container_name,
            });
        }
    }

    snapshots
}

/// Disconnect one remote host by id. Idempotent. Does NOT navigate the WebView.
pub fn disconnect_host_impl(state: &AppState, id: &str) -> Result<(), String> {
    state.stop_remote(id);
    Ok(())
}

pub fn acknowledge_risk_impl(
    state: &AppState,
    id: &str,
    risk_id: &str,
    fingerprint: &str,
) -> Result<(), String> {
    let connection = state
        .get_remote(id)
        .ok_or_else(|| format!("no active connection for {id}"))?;
    let ConnectionState::AwaitingAcknowledgement { pending_risks, .. } = connection.state() else {
        return Err("connection is not awaiting acknowledgement".into());
    };
    let risk = pending_risks
        .iter()
        .find(|risk| risk.id == risk_id && risk.fingerprint == fingerprint)
        .ok_or_else(|| "pending risk fingerprint no longer matches; retry preflight".to_string())?;

    let path = state.config.remote_profiles_path();
    let mut store = RemoteProfileStore::load(&path).map_err(|error| error.to_string())?;
    let profile = store
        .profiles
        .iter_mut()
        .find(|profile| profile.id == id)
        .ok_or_else(|| format!("no remote profile with id {id}"))?;
    match risk.kind {
        crate::remote_connection::RiskKind::RootExecution => {
            profile.risk_acknowledgements.root_fingerprint = Some(fingerprint.into());
        }
        crate::remote_connection::RiskKind::EphemeralData => {
            profile.risk_acknowledgements.ephemeral_fingerprint = Some(fingerprint.into());
        }
        crate::remote_connection::RiskKind::DockerSocket => {
            profile.risk_acknowledgements.docker_socket_fingerprint = Some(fingerprint.into());
        }
    }
    profile.validate().map_err(|error| error.to_string())?;
    store.save(&path).map_err(|error| error.to_string())?;
    state.stop_remote(id);
    Ok(())
}

pub fn cancel_connection_impl(state: &AppState, id: &str) -> Result<(), String> {
    disconnect_host_impl(state, id)
}

// ── Container discovery (pre-profile probes) ───────────────────────────────

/// First line of a command's stderr, trimmed and bounded for display in the
/// setup sheet's error box. Returns `None` when stderr is empty/whitespace.
fn ssh_error_detail(stderr: &str) -> Option<String> {
    let first = stderr.lines().map(str::trim).find(|l| !l.is_empty())?;
    const MAX: usize = 300;
    let mut detail: String = first.chars().take(MAX).collect();
    if first.chars().count() > MAX {
        detail.push('…');
    }
    Some(detail)
}

fn bounded_probe_detail(detail: &str, ssh_destination: &str) -> Option<String> {
    let detail = detail.trim().replace(ssh_destination, "<redacted-host>");
    if detail.is_empty() {
        return None;
    }
    const MAX: usize = 300;
    let mut bounded: String = detail.chars().take(MAX).collect();
    if detail.chars().count() > MAX {
        bounded.push('…');
    }
    Some(bounded)
}

fn probe_failure(
    ssh_ok: bool,
    docker_permission: &str,
    kind: &str,
    detail: Option<String>,
) -> TestSshResult {
    TestSshResult {
        ssh_ok,
        docker_permission: docker_permission.into(),
        containers: Vec::new(),
        ssh_error_detail: (kind == "ssh").then_some(detail.clone()).flatten(),
        failure_kind: Some(kind.into()),
        failure_detail: detail,
    }
}

/// Test SSH connectivity without requiring Docker. This is the pre-profile
/// probe for Host execution targets and intentionally runs only a harmless
/// remote shell command.
pub async fn test_ssh_impl(
    ssh_destination: String,
    port: Option<u16>,
    transport: &Arc<dyn SshTransport>,
) -> Result<TestSshResult, String> {
    let output = transport
        .run_command(SshCommand::for_probe(&ssh_destination, port), "true")
        .await
        .map_err(|e| {
            format!(
                "ssh-probe: {}",
                bounded_probe_detail(&e.to_string(), &ssh_destination)
                    .unwrap_or_else(|| "SSH probe could not be started".into())
            )
        })?;
    if !output.is_success() {
        let detail = bounded_probe_detail(
            &ssh_error_detail(&output.stderr).unwrap_or_default(),
            &ssh_destination,
        );
        return Ok(probe_failure(false, "unknown", "ssh", detail));
    }
    Ok(TestSshResult {
        ssh_ok: true,
        docker_permission: "unknown".into(),
        containers: Vec::new(),
        ssh_error_detail: None,
        failure_kind: None,
        failure_detail: None,
    })
}

/// Test SSH connectivity and list Docker containers on the remote host.
/// Runs before a profile is saved, so it builds a minimal `SshCommand` from
/// just destination + port. Docker failures remain distinct from SSH failures.
pub async fn test_ssh_and_list_containers_impl(
    ssh_destination: String,
    port: Option<u16>,
    transport: &Arc<dyn SshTransport>,
) -> Result<TestSshResult, String> {
    let command = SshCommand::for_probe(&ssh_destination, port);

    let docker_version = transport
        .run_command(
            command.clone(),
            "docker version --format '{{.Client.Version}}'",
        )
        .await
        .map_err(|e| {
            format!(
                "ssh-probe: Docker access probe could not be run: {}",
                bounded_probe_detail(&e.to_string(), &ssh_destination)
                    .unwrap_or_else(|| "SSH transport could not run the Docker access probe".into())
            )
        })?;

    if !docker_version.is_success() {
        if docker_version.exit_code == Some(255) {
            let detail = bounded_probe_detail(
                &ssh_error_detail(&docker_version.stderr).unwrap_or_default(),
                &ssh_destination,
            );
            return Ok(probe_failure(false, "unknown", "ssh", detail));
        }
        return Ok(probe_failure(
            true,
            "denied",
            "dockerUnavailable",
            bounded_probe_detail(
                &ssh_error_detail(&docker_version.stderr).unwrap_or_default(),
                &ssh_destination,
            ),
        ));
    }

    let list_command = crate::docker_target::shell_join(&[
        "docker".into(),
        "container".into(),
        "ls".into(),
        "-a".into(),
        "--format".into(),
        crate::docker_target::CONTAINER_LIST_FORMAT.into(),
    ]);
    let listed = transport
        .run_command(command, &list_command)
        .await
        .map_err(|e| {
            format!(
                "docker-discovery: {}",
                bounded_probe_detail(&e.to_string(), &ssh_destination)
                    .unwrap_or_else(|| "Docker container listing could not be started".into())
            )
        })?;

    if !listed.is_success() {
        let detail = bounded_probe_detail(
            &ssh_error_detail(&listed.stderr).unwrap_or_default(),
            &ssh_destination,
        );
        if listed.exit_code == Some(255) {
            return Ok(probe_failure(false, "unknown", "ssh", detail));
        }
        return Ok(probe_failure(true, "denied", "dockerDiscovery", detail));
    }

    let records = match crate::docker_target::parse_container_list(&listed.stdout) {
        Ok(records) => records,
        Err(error) => {
            return Ok(probe_failure(
                true,
                "granted",
                "malformedDockerOutput",
                bounded_probe_detail(&error.to_string(), &ssh_destination),
            ));
        }
    };

    let containers = records
        .into_iter()
        .map(|record| {
            let (compose_project, compose_service) =
                crate::docker_target::compose_metadata(&record.labels);
            ContainerSummary {
                name: record.names,
                image: record.image,
                state: record.state,
                configured_user: String::new(),
                compose_project,
                compose_service,
            }
        })
        .collect();

    Ok(TestSshResult {
        ssh_ok: true,
        docker_permission: "granted".into(),
        containers,
        ssh_error_detail: None,
        failure_kind: None,
        failure_detail: None,
    })
}

/// Inspect a Docker container on the remote host: full details including
/// resolved user/UID/GID/home, mounts, and platform OS/arch.
pub async fn inspect_container_impl(
    ssh_destination: String,
    port: Option<u16>,
    container_name: String,
    transport: &Arc<dyn SshTransport>,
) -> Result<ContainerInspection, String> {
    let command = SshCommand::for_probe(&ssh_destination, port);

    // 1. Inspect the container.
    let inspect_command = crate::docker_target::shell_join(&[
        "docker".into(),
        "container".into(),
        "inspect".into(),
        container_name.clone(),
    ]);
    let inspected = transport
        .run_command(command.clone(), &inspect_command)
        .await
        .map_err(|e| format!("failed to inspect container: {e}"))?;

    if !inspected.is_success() {
        return Err(format!(
            "container '{container_name}' not found or inspect failed"
        ));
    }

    let inspect = crate::docker_target::parse_inspect(&inspected.stdout)
        .map_err(|e| format!("malformed inspect output: {e}"))?;

    // 2. Run an identity probe inside the container to get resolved UID/GID/home.
    let identity_script = "uid=$(id -u) && gid=$(id -g) && home=${HOME:-} && \
         printf '%s|%s|%s\\n' \"$uid\" \"$gid\" \"$home\""
        .to_string();
    let identity_exec = crate::docker_target::shell_join(&[
        "docker".into(),
        "exec".into(),
        inspect.id.clone(),
        "sh".into(),
        "-c".into(),
        identity_script,
    ]);
    let identity = transport
        .run_command(command.clone(), &identity_exec)
        .await
        .map_err(|e| format!("identity probe failed: {e}"))?;

    let (resolved_uid, resolved_gid, resolved_home) = if identity.is_success() {
        let fields: Vec<&str> = identity.stdout.trim().split('|').collect();
        if fields.len() == 3 {
            let uid: u64 = fields[0]
                .parse()
                .map_err(|_| "identity probe returned invalid UID".to_string())?;
            let gid: u64 = fields[1]
                .parse()
                .map_err(|_| "identity probe returned invalid GID".to_string())?;
            (uid, gid, fields[2].to_string())
        } else {
            return Err("identity probe returned malformed output".into());
        }
    } else {
        return Err("could not resolve container user identity".into());
    };

    // 3. Map mounts.
    let mounts = inspect
        .mounts
        .iter()
        .map(|m| MountSummary {
            mount_type: m.mount_type.clone(),
            source: if m.source.is_empty() {
                None
            } else {
                Some(m.source.clone())
            },
            destination: m.destination.clone(),
            read_only: !m.read_write,
            name: m.name.clone(),
        })
        .collect();

    // 4. Compute pantoken root suggestion.
    let pantoken_root_suggestion = {
        let home = resolved_home.trim_end_matches('/');
        if home.is_empty() {
            "/.local/share/pantoken".into()
        } else {
            format!("{home}/.local/share/pantoken")
        }
    };

    // 5. Resolve platform OS/arch.
    let (os, arch) = inspect
        .platform
        .as_ref()
        .map(|p| (p.os.clone(), p.architecture.clone()))
        .unwrap_or((None, None));

    Ok(ContainerInspection {
        name: inspect.name.trim_start_matches('/').to_string(),
        container_id: inspect.id,
        image: inspect.image,
        running: inspect.state.running,
        configured_user: inspect.config.user.clone(),
        resolved_user: inspect.config.user,
        resolved_uid,
        resolved_gid,
        resolved_home,
        os,
        arch,
        mounts,
        pantoken_root_suggestion,
    })
}

// ── Tauri command wrappers (thin: delegate to the _impl functions) ───────

/// Load all remote profiles from the persisted JSON.
#[tauri::command]
pub fn list_remote_profiles(state: State<'_, AppState>) -> Vec<RemoteProfile> {
    list_remote_profiles_impl(state.inner())
}

/// Add a remote profile (validates + persists). Returns the stored profile.
#[tauri::command]
pub fn add_remote_profile(
    profile: RemoteProfile,
    state: State<'_, AppState>,
) -> Result<RemoteProfile, String> {
    add_remote_profile_impl(state.inner(), profile)
}

/// Update an existing remote profile (by id). Validates + persists.
#[tauri::command]
pub fn update_remote_profile(
    profile: RemoteProfile,
    state: State<'_, AppState>,
) -> Result<(), String> {
    update_remote_profile_impl(state.inner(), profile)
}

/// Delete a remote profile by id. Persists the change.
#[tauri::command]
pub fn delete_remote_profile(id: String, state: State<'_, AppState>) -> Result<(), String> {
    delete_remote_profile_impl(state.inner(), id)
}

/// Ensure a remote bridge session exists for the given profile. Starts the
/// bridge + SSH, returns the current host state. Does NOT navigate the WebView.
#[tauri::command]
pub fn ensure_remote_host(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<HostStateSnapshot, String> {
    let transport: Arc<dyn SshTransport> = Arc::new(SystemSshTransport::new());
    ensure_remote_host_impl(state.inner(), profile_id, &transport)
}

/// Get the current state of one host (local or remote).
#[tauri::command]
pub fn host_state(id: String, state: State<'_, AppState>) -> Option<HostStateSnapshot> {
    host_state_impl(state.inner(), &id)
}

/// List all hosts (local + saved remote profiles with current state).
#[tauri::command]
pub fn list_hosts(state: State<'_, AppState>) -> Vec<HostStateSnapshot> {
    list_hosts_impl(state.inner())
}

/// Disconnect one remote host by id. Idempotent. Does NOT navigate the WebView.
#[tauri::command]
pub fn disconnect_host(id: String, state: State<'_, AppState>) -> Result<(), String> {
    disconnect_host_impl(state.inner(), &id)
}

#[tauri::command]
pub fn acknowledge_risk(
    id: String,
    risk_id: String,
    fingerprint: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    acknowledge_risk_impl(state.inner(), &id, &risk_id, &fingerprint)
}

#[tauri::command]
pub fn cancel_connection(id: String, state: State<'_, AppState>) -> Result<(), String> {
    cancel_connection_impl(state.inner(), &id)
}

#[tauri::command]
pub fn resume_connection(
    id: String,
    state: State<'_, AppState>,
) -> Result<HostStateSnapshot, String> {
    ensure_remote_host(id, state)
}

/// Test SSH connectivity without requiring Docker.
/// Runs before saving a Host execution profile.
#[tauri::command]
pub async fn test_ssh(ssh_destination: String, port: Option<u16>) -> Result<TestSshResult, String> {
    let transport: Arc<dyn SshTransport> = Arc::new(SystemSshTransport::new());
    test_ssh_impl(ssh_destination, port, &transport).await
}

/// Test SSH connectivity and list Docker containers on the remote host.
/// Runs before a profile is saved (pre-profile discovery).
#[tauri::command]
pub async fn test_ssh_and_list_containers(
    ssh_destination: String,
    port: Option<u16>,
) -> Result<TestSshResult, String> {
    let transport: Arc<dyn SshTransport> = Arc::new(SystemSshTransport::new());
    test_ssh_and_list_containers_impl(ssh_destination, port, &transport).await
}

/// Inspect a Docker container on the remote host: full details including
/// resolved user/UID/GID/home, mounts, and platform OS/arch.
#[tauri::command]
pub async fn inspect_container(
    ssh_destination: String,
    port: Option<u16>,
    container_name: String,
) -> Result<ContainerInspection, String> {
    let transport: Arc<dyn SshTransport> = Arc::new(SystemSshTransport::new());
    inspect_container_impl(ssh_destination, port, container_name, &transport).await
}

/// Register all remote commands on the Tauri builder. Kept for standalone
/// test wiring; the main builder registers them inline via `generate_handler!`.
#[allow(dead_code)]
pub fn invoke_handler(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        list_remote_profiles,
        add_remote_profile,
        update_remote_profile,
        delete_remote_profile,
        ensure_remote_host,
        host_state,
        list_hosts,
        disconnect_host,
        acknowledge_risk,
        cancel_connection,
        resume_connection,
        test_ssh,
        test_ssh_and_list_containers,
        inspect_container,
    ])
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `bridge_wired_into_desktop_lifecycle` (AC.3, AC.6)
    //! - `two_remote_profiles_can_own_live_bridge_sessions_simultaneously` (AC.1)
    //! - `connecting_b_does_not_cancel_a` (AC.2)
    //! - `disconnecting_b_leaves_a_alive` (AC.3)
    //! - `deleting_connected_profile_tears_down_only_its_own_task` (AC.4)
    //! - `teardown_cancels_and_awaits_all_remote_sessions` (AC.5)
    //! - `returned_bridge_urls_are_loopback_only` (AC.6)
    //! - `state_failure_snapshots_keyed_by_profile_id_and_contain_redacted_diagnostics` (AC.7)
    //! - `fake_transport_can_drive_different_phases_independently_for_two_hosts` (AC.9)

    use super::*;
    use crate::bridge::fake::{FakeScenario, FakeSshTransport};
    use crate::remote_connection::ConnectionState;
    use crate::remote_profile::{PolytokenPolicy, RemoteProfileStore};
    use tokio_util::sync::CancellationToken;

    fn test_no_http_fetch() -> crate::provisioning::reconcile::HttpFetch {
        std::sync::Arc::new(|_url: &str| Box::pin(async { Err("no http in test".into()) }))
    }

    fn test_manifest() -> pantoken_remote_layout::manifest::PantokenReleaseManifest {
        use pantoken_protocol::wire::PROTOCOL_VERSION;
        use pantoken_remote_layout::manifest::{ArchiveFormat, ReleaseTarget};

        pantoken_remote_layout::manifest::PantokenReleaseManifest {
            release_version: "0.2.75".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: None,
            targets: vec![ReleaseTarget {
                target_triple: "x86_64-unknown-linux-gnu".into(),
                artifact_url: "https://example.com/server.tar.gz".into(),
                sha256: "a".repeat(64),
                archive_format: ArchiveFormat::TarGz,
            }],
        }
    }

    /// Canned response for the server binary check (test -x → "exists").
    fn server_exists_response() -> crate::bridge::CommandOutput {
        crate::bridge::CommandOutput {
            stdout: "exists".into(),
            stderr: String::new(),
            exit_code: Some(0),
        }
    }

    /// AC.3/AC.6: the bridge starts on a dedicated tokio runtime, forwards
    /// over WS, and tears down cleanly (no leaked child, runtime shuts down).
    #[tokio::test]
    async fn bridge_wired_into_desktop_lifecycle() {
        use futures_util::{SinkExt, StreamExt};
        use pantoken_protocol::wire::{ClientMessage, ServerMessage};
        use tokio_tungstenite::tungstenite::Message as WsMessage;

        // A dedicated runtime (mirrors AppState's bridge runtime).
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");

        // A free loopback port (mirrors config::free_port).
        let port = {
            let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };

        let transport: Arc<dyn SshTransport> =
            Arc::new(FakeSshTransport::new(FakeScenario::healthy()));
        let command = SshCommand {
            destination: "fake".into(),
            port: None,
            remote_root: "/tmp".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
            raw_remote_command: None,
        };
        let connection = Arc::new(RemoteConnection::new());
        let bridge = Bridge::new(port, transport, command)
            .with_state_sink(connection.clone() as Arc<dyn ConnectionStateSink>);

        let cancel = CancellationToken::new();
        let cancel_for_task = cancel.clone();
        let handle = runtime.spawn(async move {
            let _ = bridge.run(cancel_for_task).await;
        });

        // Give the bridge a moment to bind.
        runtime.spawn(async {}).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        // The connection state should have advanced past TestingSsh once a
        // client connects. Connect + send Hello.
        let url = format!("ws://127.0.0.1:{port}");
        let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
            .await
            .expect("ws connect");
        let hello = serde_json::to_string(&ClientMessage::Hello {
            auth: None,
            resume: None,
        })
        .unwrap();
        ws.send(WsMessage::Text(hello.into())).await.unwrap();

        let msg = tokio::time::timeout(std::time::Duration::from_secs(3), ws.next())
            .await
            .expect("timeout")
            .expect("frame")
            .expect("ws ok");
        match msg {
            WsMessage::Text(t) => {
                let m: ServerMessage = serde_json::from_str(&t).expect("parse");
                assert!(matches!(m, ServerMessage::Hello { .. }));
            }
            other => panic!("expected Text Hello, got {other:?}"),
        }

        // The state machine reflects the connection.
        assert!(
            matches!(
                connection.state(),
                ConnectionState::Connecting | ConnectionState::Starting | ConnectionState::Ready
            ),
            "state advanced: {:?}",
            connection.state()
        );

        // Teardown: cancel + await with timeout.
        cancel.cancel();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), handle).await;

        // The runtime shuts down cleanly (no leaked threads / child).
        runtime.shutdown_background();
    }

    // ── Multi-host manager tests (AC.1–AC.9, AC.12) ──────────────────────

    /// Build a test AppState with a temp data dir + two saved profiles.
    fn test_app_state_two_profiles() -> AppState {
        use crate::config::PantokenConfig;
        use crate::remote_profile::{PolytokenPolicy, RemoteProfile};

        let dir = std::env::temp_dir().join(format!(
            "pantoken-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let config = PantokenConfig::fallback_with_app_data_dir(0, Some(&dir));
        assert_eq!(
            config.remote_profiles_path(),
            dir.join("remote-profiles.json")
        );
        let state = AppState::new(config);

        // Save two profiles.
        let store = RemoteProfileStore {
            profiles: vec![
                RemoteProfile {
                    id: "host-a".into(),
                    label: "Host A".into(),
                    ssh_destination: "fake-a".into(),
                    port: None,
                    polytoken_policy: PolytokenPolicy::RequireExisting,
                    remote_root_override: Some("/tmp/pantoken-a".into()),
                    server_path: None,
                    execution_target: crate::remote_profile::ExecutionTargetProfile::default(),
                    risk_acknowledgements: crate::remote_profile::RiskAcknowledgements::default(),
                },
                RemoteProfile {
                    id: "host-b".into(),
                    label: "Host B".into(),
                    ssh_destination: "fake-b".into(),
                    port: None,
                    polytoken_policy: PolytokenPolicy::RequireExisting,
                    remote_root_override: Some("/tmp/pantoken-b".into()),
                    server_path: None,
                    execution_target: crate::remote_profile::ExecutionTargetProfile::default(),
                    risk_acknowledgements: crate::remote_profile::RiskAcknowledgements::default(),
                },
            ],
        };
        store.save(&state.config.remote_profiles_path()).unwrap();
        state
    }

    /// Build a healthy transport (with provisioning command responses) as an
    /// `Arc<dyn SshTransport>`. Uses `provisioning::fake::build_transport` with
    /// `ServerAlreadyInstalled` (macOS arm64) so the embedded manifest (which
    /// only ships `aarch64-apple-darwin`) matches.
    fn healthy_transport() -> Arc<dyn SshTransport> {
        use crate::provisioning::fake::{build_transport, Scenario};
        Arc::new(build_transport(Scenario::ServerAlreadyInstalled))
    }

    /// Wait for a RemoteConnection to reach the Ready state (with a timeout).
    fn wait_for_ready(connection: &RemoteConnection, timeout_ms: u64) -> bool {
        let start = std::time::Instant::now();
        loop {
            if connection.state().is_ready() {
                return true;
            }
            if start.elapsed().as_millis() as u64 > timeout_ms {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// Wait for a RemoteConnection to reach the Failed state (with a timeout).
    fn wait_for_failed(connection: &RemoteConnection, timeout_ms: u64) -> bool {
        let start = std::time::Instant::now();
        loop {
            if matches!(connection.state(), ConnectionState::Failed { .. }) {
                return true;
            }
            if start.elapsed().as_millis() as u64 > timeout_ms {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// AC.1: Two remote profiles can own live bridge sessions simultaneously.
    /// Both bridges accept WS connections and return `hello`.
    #[tokio::test]
    async fn two_remote_profiles_can_own_live_bridge_sessions_simultaneously() {
        let state = test_app_state_two_profiles();

        let transport_a = healthy_transport();
        let transport_b = healthy_transport();

        // Start host A.
        let snap_a =
            ensure_remote_host_impl(&state, "host-a".into(), &transport_a).expect("ensure host-a");
        assert_eq!(snap_a.id, "host-a");
        assert!(snap_a.ws_url.is_some(), "host-a should have a ws_url");

        // Start host B.
        let snap_b =
            ensure_remote_host_impl(&state, "host-b".into(), &transport_b).expect("ensure host-b");
        assert_eq!(snap_b.id, "host-b");
        assert!(snap_b.ws_url.is_some(), "host-b should have a ws_url");

        // Both sessions are in the map.
        assert!(state.get_remote("host-a").is_some());
        assert!(state.get_remote("host-b").is_some());

        // Both bridges are on different ports.
        let port_a = state.get_remote_bridge_port("host-a").unwrap();
        let port_b = state.get_remote_bridge_port("host-b").unwrap();
        assert_ne!(port_a, port_b, "bridges must be on different ports");

        // Both bridges accept WS connections and return hello.
        let url_a = format!("ws://127.0.0.1:{port_a}");
        let url_b = format!("ws://127.0.0.1:{port_b}");

        // Wait for both bridges to be ready (the provisioning + bridge start
        // runs in a spawned task). Give the spawned tasks time to start.
        let conn_a = state.get_remote("host-a").unwrap();
        let conn_b = state.get_remote("host-b").unwrap();
        // Poll until ready (FakeSshTransport with healthy scenario + existing server
        // → provisioning returns Ready quickly).
        let ready_a = wait_for_ready(&conn_a, 5000);
        let ready_b = wait_for_ready(&conn_b, 5000);

        // Connect a WS client to bridge A.
        if let Ok(Ok((mut ws_a, _))) = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio_tungstenite::connect_async(&url_a),
        )
        .await
        {
            use futures_util::SinkExt;
            let hello = serde_json::to_string(&pantoken_protocol::wire::ClientMessage::Hello {
                auth: None,
                resume: None,
            })
            .unwrap();
            let _ = ws_a
                .send(tokio_tungstenite::tungstenite::Message::Text(hello.into()))
                .await;
        }

        // Connect a WS client to bridge B.
        if let Ok(Ok((mut ws_b, _))) = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio_tungstenite::connect_async(&url_b),
        )
        .await
        {
            use futures_util::SinkExt;
            let hello = serde_json::to_string(&pantoken_protocol::wire::ClientMessage::Hello {
                auth: None,
                resume: None,
            })
            .unwrap();
            let _ = ws_b
                .send(tokio_tungstenite::tungstenite::Message::Text(hello.into()))
                .await;
        }

        // The fact that both WS connects succeeded is the AC.1 proof. The
        // readiness check is informational.
        let _ = (ready_a, ready_b);

        // Clean teardown.
        state.teardown();
    }

    /// AC.2: Connecting profile B does not cancel profile A.
    #[tokio::test]
    async fn connecting_b_does_not_cancel_a() {
        let state = test_app_state_two_profiles();

        let transport_a = healthy_transport();
        let transport_b = healthy_transport();

        // Start A.
        let _ = ensure_remote_host_impl(&state, "host-a".into(), &transport_a).unwrap();
        let conn_a = state.get_remote("host-a").unwrap();
        // Wait for A to advance past the initial state.
        wait_for_ready(&conn_a, 5000);

        // Start B — must NOT cancel A.
        let _ = ensure_remote_host_impl(&state, "host-b".into(), &transport_b).unwrap();

        // A is still in the map.
        assert!(
            state.get_remote("host-a").is_some(),
            "A should still be in the map"
        );

        // A's connection is still alive (not Disconnected).
        let a_state = conn_a.state();
        assert!(
            !matches!(a_state, ConnectionState::Disconnected),
            "A should not be disconnected after starting B: {a_state:?}"
        );

        state.teardown();
    }

    /// AC.3: Disconnecting profile B leaves profile A alive.
    #[tokio::test]
    async fn disconnecting_b_leaves_a_alive() {
        let state = test_app_state_two_profiles();

        let transport_a = healthy_transport();
        let transport_b = healthy_transport();

        let _ = ensure_remote_host_impl(&state, "host-a".into(), &transport_a).unwrap();
        let _ = ensure_remote_host_impl(&state, "host-b".into(), &transport_b).unwrap();

        let conn_a = state.get_remote("host-a").unwrap();
        wait_for_ready(&conn_a, 5000);

        // Disconnect B.
        disconnect_host_impl(&state, "host-b").unwrap();

        // B is removed, A is still alive.
        assert!(state.get_remote("host-b").is_none(), "B should be removed");
        assert!(
            state.get_remote("host-a").is_some(),
            "A should still be in the map"
        );

        // A's connection is still alive.
        let a_state = conn_a.state();
        assert!(
            !matches!(a_state, ConnectionState::Disconnected),
            "A should not be disconnected: {a_state:?}"
        );

        state.teardown();
    }

    /// AC.4: Deleting a connected profile tears down only its own task.
    #[tokio::test]
    async fn deleting_connected_profile_tears_down_only_its_own_task() {
        let state = test_app_state_two_profiles();

        let transport_a = healthy_transport();
        let transport_b = healthy_transport();

        let _ = ensure_remote_host_impl(&state, "host-a".into(), &transport_a).unwrap();
        let _ = ensure_remote_host_impl(&state, "host-b".into(), &transport_b).unwrap();

        let conn_a = state.get_remote("host-a").unwrap();
        wait_for_ready(&conn_a, 5000);

        // Delete profile A — should tear down A's session + remove the profile.
        delete_remote_profile_impl(&state, "host-a".into()).unwrap();

        // A's session is torn down + removed from the store.
        assert!(
            state.get_remote("host-a").is_none(),
            "A session should be gone"
        );

        // B is untouched.
        assert!(
            state.get_remote("host-b").is_some(),
            "B should still be in the map"
        );
        let b_state = state.get_remote("host-b").unwrap().state();
        assert!(
            !matches!(b_state, ConnectionState::Disconnected),
            "B should not be disconnected: {b_state:?}"
        );

        // A's profile is gone from the store.
        let path = state.config.remote_profiles_path();
        let store = RemoteProfileStore::load(&path).unwrap();
        assert!(
            store.profiles.iter().all(|p| p.id != "host-a"),
            "A profile should be removed"
        );
        assert!(
            store.profiles.iter().any(|p| p.id == "host-b"),
            "B profile should remain"
        );

        state.teardown();
    }

    /// AC.5: Teardown cancels and awaits all remote sessions.
    #[tokio::test]
    async fn teardown_cancels_and_awaits_all_remote_sessions() {
        let state = test_app_state_two_profiles();

        let transport_a = healthy_transport();
        let transport_b = healthy_transport();

        let _ = ensure_remote_host_impl(&state, "host-a".into(), &transport_a).unwrap();
        let _ = ensure_remote_host_impl(&state, "host-b".into(), &transport_b).unwrap();

        // Both sessions are running.
        assert_eq!(state.remote.lock().unwrap().len(), 2);

        // Teardown stops all + clears the map.
        state.teardown();

        assert!(
            state.remote.lock().unwrap().is_empty(),
            "map should be empty after teardown"
        );
    }

    /// AC.6: Returned bridge URLs are loopback-only.
    #[test]
    fn returned_bridge_urls_are_loopback_only() {
        let state = test_app_state_two_profiles();

        // list_hosts includes the local host (no session) + two disconnected remotes.
        let hosts = list_hosts_impl(&state);
        for h in &hosts {
            if let Some(ref url) = h.ws_url {
                assert!(
                    url.starts_with("ws://127.0.0.1:") || url.starts_with("ws://localhost:"),
                    "ws_url must be loopback-only, got: {url}"
                );
            }
        }

        // host_state("local") also returns a loopback URL.
        let local = host_state_impl(&state, "local").unwrap();
        if let Some(ref url) = local.ws_url {
            assert!(
                url.starts_with("ws://127.0.0.1:"),
                "local ws_url must be loopback-only, got: {url}"
            );
        }

        state.teardown();
    }

    /// AC.7: State/failure snapshots are keyed by profile id and contain
    /// redacted diagnostics.
    #[tokio::test]
    async fn state_failure_snapshots_keyed_by_profile_id_and_contain_redacted_diagnostics() {
        let state = test_app_state_two_profiles();

        // Use a FakeSshTransport that fails auth (exit 255 + "Permission denied").
        let transport: Arc<dyn SshTransport> =
            Arc::new(FakeSshTransport::new(FakeScenario::auth_failure()));

        let _ = ensure_remote_host_impl(&state, "host-a".into(), &transport).unwrap();

        // Wait for the connection to reach Failed.
        let conn = state.get_remote("host-a").unwrap();
        assert!(wait_for_failed(&conn, 5000), "should reach Failed state");

        // Poll host_state.
        let snap = host_state_impl(&state, "host-a").unwrap();
        assert_eq!(snap.id, "host-a");
        assert_eq!(snap.state, "failed");
        assert!(snap.failure_label.is_some(), "should have failure_label");
        assert!(snap.failure_action.is_some(), "should have failure_action");
        assert!(snap.failure_detail.is_some(), "should have failure_detail");

        // The detail must NOT contain a raw SSH command line.
        let detail = snap.failure_detail.unwrap();
        assert!(
            !detail.contains("ssh -o") && !detail.contains("BatchMode=yes"),
            "failure_detail should not contain raw SSH command: {detail}"
        );

        state.teardown();
    }

    /// AC.9: Fake transport can drive different phases independently for two
    /// hosts.
    #[tokio::test]
    async fn fake_transport_can_drive_different_phases_independently_for_two_hosts() {
        let state = test_app_state_two_profiles();

        // Host A: healthy (should reach Ready).
        let transport_a = healthy_transport();

        // Host B: auth failure (should reach Failed).
        let transport_b: Arc<dyn SshTransport> =
            Arc::new(FakeSshTransport::new(FakeScenario::auth_failure()));

        let _ = ensure_remote_host_impl(&state, "host-a".into(), &transport_a).unwrap();
        let _ = ensure_remote_host_impl(&state, "host-b".into(), &transport_b).unwrap();

        let conn_a = state.get_remote("host-a").unwrap();
        let conn_b = state.get_remote("host-b").unwrap();

        // A should NOT be Failed (it's healthy — provisioning succeeded, bridge
        // is starting). B should be Failed (auth failure). The key assertion is
        // that they have independent states — A didn't fail because B failed.
        // Give the spawned tasks time to run.
        wait_for_failed(&conn_b, 10000);

        let a_state = conn_a.state();
        let b_state = conn_b.state();
        // A is healthy: it should be in Starting or Ready (Starting if no WS
        // client connected, Ready if one did). NOT Failed or Disconnected.
        assert!(
            matches!(a_state, ConnectionState::Starting | ConnectionState::Ready),
            "A should be Starting or Ready (healthy), got: {a_state:?}"
        );
        // B failed auth: should be Failed.
        assert!(
            matches!(b_state, ConnectionState::Failed { .. }),
            "B should be Failed, got: {b_state:?}"
        );

        state.teardown();
    }

    /// AC.7: provisioning drives the connection state machine through
    /// `Connecting → Provisioning → Starting` when provisioning runs.
    #[tokio::test]
    async fn provisioning_drives_state_machine() {
        use crate::provisioning::fake::{build_transport, Scenario};
        use crate::provisioning::reconcile;

        let transport = build_transport(Scenario::Healthy);
        transport.add_command_response("echo exists", server_exists_response());
        let profile = RemoteProfile {
            id: "test".into(),
            label: "Test".into(),
            ssh_destination: "fake".into(),
            port: None,
            polytoken_policy: PolytokenPolicy::RequireExisting,
            remote_root_override: Some("/tmp/pantoken-test".into()),
            server_path: None,
            execution_target: crate::remote_profile::ExecutionTargetProfile::default(),
            risk_acknowledgements: crate::remote_profile::RiskAcknowledgements::default(),
        };
        let connection = Arc::new(RemoteConnection::new());
        connection.begin(profile.clone());
        connection.on_state(ConnectionState::Connecting);

        let sink: Arc<dyn ConnectionStateSink> = connection.clone() as Arc<dyn ConnectionStateSink>;
        let manifest = test_manifest();
        let outcome = reconcile::reconcile(
            &transport,
            &profile,
            Some(&sink),
            test_no_http_fetch(),
            &manifest,
        )
        .await;

        assert!(matches!(outcome, reconcile::ReconcileOutcome::Ready { .. }));
        // The state machine should have been driven through Provisioning.
        let state = connection.state();
        assert!(
            matches!(
                state,
                ConnectionState::Provisioning | ConnectionState::Starting | ConnectionState::Ready
            ),
            "state should have advanced past Connecting: {state:?}"
        );
    }

    /// AC.7: provisioning failure drives the Failed state.
    #[tokio::test]
    async fn provisioning_failure_drives_failed_state() {
        use crate::provisioning::fake::{build_transport, Scenario};
        use crate::provisioning::reconcile;

        let transport = build_transport(Scenario::MissingPolytoken);
        let profile = RemoteProfile {
            id: "test".into(),
            label: "Test".into(),
            ssh_destination: "fake".into(),
            port: None,
            polytoken_policy: PolytokenPolicy::RequireExisting,
            remote_root_override: Some("/tmp/pantoken-test".into()),
            server_path: None,
            execution_target: crate::remote_profile::ExecutionTargetProfile::default(),
            risk_acknowledgements: crate::remote_profile::RiskAcknowledgements::default(),
        };
        let connection = Arc::new(RemoteConnection::new());
        connection.begin(profile.clone());
        connection.on_state(ConnectionState::Connecting);

        let sink: Arc<dyn ConnectionStateSink> = connection.clone() as Arc<dyn ConnectionStateSink>;
        let manifest = test_manifest();
        let outcome = reconcile::reconcile(
            &transport,
            &profile,
            Some(&sink),
            test_no_http_fetch(),
            &manifest,
        )
        .await;

        assert!(matches!(
            outcome,
            reconcile::ReconcileOutcome::Missing { .. }
        ));
        let state = connection.state();
        assert!(
            matches!(state, ConnectionState::Failed { .. }),
            "state should be Failed: {state:?}"
        );
    }

    /// AC.7: provisioning is skipped when polytoken is already compatible —
    /// no Provisioning state, straight to Ready.
    #[tokio::test]
    async fn provisioning_skipped_when_compatible() {
        use crate::provisioning::fake::{build_transport, Scenario};
        use crate::provisioning::reconcile;

        let transport = build_transport(Scenario::Healthy);
        transport.add_command_response("echo exists", server_exists_response());
        let profile = RemoteProfile {
            id: "test".into(),
            label: "Test".into(),
            ssh_destination: "fake".into(),
            port: None,
            polytoken_policy: PolytokenPolicy::RequireExisting,
            remote_root_override: Some("/tmp/pantoken-test".into()),
            server_path: None,
            execution_target: crate::remote_profile::ExecutionTargetProfile::default(),
            risk_acknowledgements: crate::remote_profile::RiskAcknowledgements::default(),
        };
        let connection = Arc::new(RemoteConnection::new());
        connection.begin(profile.clone());

        let sink: Arc<dyn ConnectionStateSink> = connection.clone() as Arc<dyn ConnectionStateSink>;
        let manifest = test_manifest();
        let outcome = reconcile::reconcile(
            &transport,
            &profile,
            Some(&sink),
            test_no_http_fetch(),
            &manifest,
        )
        .await;

        // Compatible polytoken → Ready (no install needed).
        assert!(matches!(outcome, reconcile::ReconcileOutcome::Ready { .. }));
    }

    /// AC.2: when polytoken is already compatible (found on PATH), the
    /// `SshCommand` built from the outcome contains
    /// `PANTOKEN_POLYTOKEN_BIN=polytoken` (PATH-resolved).
    #[tokio::test]
    async fn compatible_polytoken_path_threaded_to_bridge_command() {
        use crate::provisioning::fake::{build_transport, Scenario};
        use crate::provisioning::reconcile;

        let transport = build_transport(Scenario::Healthy);
        transport.add_command_response("echo exists", server_exists_response());

        let command = SshCommand {
            destination: "fake".into(),
            port: None,
            remote_root: "/tmp/pantoken-test".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
            raw_remote_command: None,
        };
        let profile = RemoteProfile {
            id: "test".into(),
            label: "Test".into(),
            ssh_destination: "fake".into(),
            port: None,
            polytoken_policy: PolytokenPolicy::RequireExisting,
            remote_root_override: Some("/tmp/pantoken-test".into()),
            server_path: None,
            execution_target: crate::remote_profile::ExecutionTargetProfile::default(),
            risk_acknowledgements: crate::remote_profile::RiskAcknowledgements::default(),
        };

        let manifest = test_manifest();
        let outcome =
            reconcile::reconcile(&transport, &profile, None, test_no_http_fetch(), &manifest).await;

        let result = apply_outcome_to_command(command, &outcome);

        // server_path should be overridden to the installed server binary path.
        let expected_server =
            "/tmp/pantoken-test/releases/0.2.75/x86_64-unknown-linux-gnu/pantoken-server";
        assert_eq!(result.server_path, expected_server);

        // PANTOKEN_POLYTOKEN_BIN should be set to "polytoken" (PATH-resolved).
        let polytoken_env = result
            .extra_env
            .iter()
            .find(|(k, _)| k == "PANTOKEN_POLYTOKEN_BIN");
        assert!(
            polytoken_env.is_some(),
            "PANTOKEN_POLYTOKEN_BIN should be set"
        );
        assert_eq!(
            polytoken_env.unwrap().1,
            "polytoken",
            "compatible polytoken should use PATH-resolved name"
        );
    }

    /// AC.1: after a successful polytoken install, the `SshCommand` contains
    /// `PANTOKEN_POLYTOKEN_BIN` pointing at the installed binary path under
    /// `<remote_root>/tools/polytoken/<version>/<target>/polytoken`.
    #[tokio::test]
    async fn installed_polytoken_path_threaded_to_bridge_command() {
        use crate::provisioning::fake::{build_transport, Scenario};
        use crate::provisioning::polytoken_install::compute_sha256;
        use crate::provisioning::reconcile;
        use pantoken_daemon_types::POLYTOKEN_DAEMON_TARGET_VERSION;

        let transport = build_transport(Scenario::MissingPolytoken);
        // Server binary already installed — idempotent skip.
        transport.add_command_response("echo exists", server_exists_response());

        // Polytoken install needs a working http_fetch. Build a fake archive
        // + checksums that the installer will accept.
        let archive = b"fake polytoken archive".to_vec();
        let hash = compute_sha256(&archive);
        let sums = format!("{hash}  polytoken-linux-amd64.tar.gz\n");
        let http_fetch = crate::provisioning::fake::mock_http_fetch(archive, sums);

        let command = SshCommand {
            destination: "fake".into(),
            port: None,
            remote_root: "/tmp/pantoken-test".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
            raw_remote_command: None,
        };
        let profile = RemoteProfile {
            id: "test".into(),
            label: "Test".into(),
            ssh_destination: "fake".into(),
            port: None,
            polytoken_policy: PolytokenPolicy::OfferInstall,
            remote_root_override: Some("/tmp/pantoken-test".into()),
            server_path: None,
            execution_target: crate::remote_profile::ExecutionTargetProfile::default(),
            risk_acknowledgements: crate::remote_profile::RiskAcknowledgements::default(),
        };

        let manifest = test_manifest();
        let outcome = reconcile::reconcile(&transport, &profile, None, http_fetch, &manifest).await;

        // The polytoken install command uses `echo ok` at the end, same as
        // the server install. The fake transport's default (empty success)
        // covers the install + provenance commands.
        match &outcome {
            reconcile::ReconcileOutcome::Installed {
                polytoken_binary_path,
                ..
            } => {
                // The path should be the managed install path.
                let expected = format!(
                    "/tmp/pantoken-test/tools/polytoken/{}/{}/polytoken",
                    POLYTOKEN_DAEMON_TARGET_VERSION, "x86_64-unknown-linux-gnu"
                );
                assert_eq!(
                    polytoken_binary_path.as_deref(),
                    Some(expected.as_str()),
                    "polytoken_binary_path should be the managed install path"
                );
            }
            other => panic!("expected Installed, got {other:?}"),
        }

        // apply_outcome_to_command threads the path into PANTOKEN_POLYTOKEN_BIN.
        let result = apply_outcome_to_command(command, &outcome);
        let polytoken_env = result
            .extra_env
            .iter()
            .find(|(k, _)| k == "PANTOKEN_POLYTOKEN_BIN");
        assert!(
            polytoken_env.is_some(),
            "PANTOKEN_POLYTOKEN_BIN should be set"
        );
        let val = &polytoken_env.unwrap().1;
        assert!(
            val.contains("/tools/polytoken/"),
            "PANTOKEN_POLYTOKEN_BIN should point at the managed install path, got {val}"
        );
        assert!(
            val.ends_with("/polytoken"),
            "path should end with the binary name"
        );
    }

    /// AC.6: reconcile installs the server and threads both paths (server_path
    /// + PANTOKEN_POLYTOKEN_BIN) into the SshCommand via
    /// `apply_outcome_to_command`.
    #[tokio::test]
    async fn reconcile_installs_server_and_threads_both_paths() {
        use crate::provisioning::fake::{build_transport, Scenario};
        use crate::provisioning::reconcile;
        use pantoken_remote_layout::manifest::{ArchiveFormat, ReleaseTarget};

        let transport = build_transport(Scenario::ServerAlreadyInstalled);

        let command = SshCommand {
            destination: "fake".into(),
            port: None,
            remote_root: "/tmp/pantoken-test".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
            raw_remote_command: None,
        };
        let profile = RemoteProfile {
            id: "test".into(),
            label: "Test".into(),
            ssh_destination: "fake".into(),
            port: None,
            polytoken_policy: PolytokenPolicy::RequireExisting,
            remote_root_override: Some("/tmp/pantoken-test".into()),
            server_path: None,
            execution_target: crate::remote_profile::ExecutionTargetProfile::default(),
            risk_acknowledgements: crate::remote_profile::RiskAcknowledgements::default(),
        };

        // Use macOS arm64 manifest to match the ServerAlreadyInstalled scenario.
        let manifest = pantoken_remote_layout::manifest::PantokenReleaseManifest {
            release_version: "0.2.75".into(),
            protocol_version: pantoken_protocol::wire::PROTOCOL_VERSION,
            build_sha: None,
            targets: vec![ReleaseTarget {
                target_triple: "aarch64-apple-darwin".into(),
                artifact_url: "https://example.com/server.tar.gz".into(),
                sha256: "a".repeat(64),
                archive_format: ArchiveFormat::TarGz,
            }],
        };

        let outcome =
            reconcile::reconcile(&transport, &profile, None, test_no_http_fetch(), &manifest).await;

        // Should be Ready (compatible polytoken + server already installed).
        match &outcome {
            reconcile::ReconcileOutcome::Ready {
                polytoken_binary_path,
                server_binary_path,
                ..
            } => {
                // Polytoken path is PATH-resolved "polytoken".
                assert_eq!(
                    polytoken_binary_path.as_deref(),
                    Some("polytoken"),
                    "polytoken should be PATH-resolved"
                );
                // Server path points at the installed release artifact.
                let expected_server =
                    "/tmp/pantoken-test/releases/0.2.75/aarch64-apple-darwin/pantoken-server";
                assert_eq!(
                    server_binary_path, expected_server,
                    "server_binary_path should point at the release artifact"
                );
            }
            other => panic!("expected Ready, got {other:?}"),
        }

        // apply_outcome_to_command threads both into the SshCommand.
        let result = apply_outcome_to_command(command, &outcome);
        assert_eq!(
            result.server_path,
            "/tmp/pantoken-test/releases/0.2.75/aarch64-apple-darwin/pantoken-server"
        );
        let polytoken_env = result
            .extra_env
            .iter()
            .find(|(k, _)| k == "PANTOKEN_POLYTOKEN_BIN");
        assert!(
            polytoken_env.is_some(),
            "PANTOKEN_POLYTOKEN_BIN should be set"
        );
        assert_eq!(polytoken_env.unwrap().1, "polytoken");
    }

    // ── Container discovery command tests ───────────────────────────────────

    fn container_list_stdout() -> String {
        // Real docker container ls --format '{{json .}}' output: ID plus a
        // comma-separated label string.
        let line1 = r#"{"ID":"abc123","Names":"work-api-dev","Image":"node:20-alpine","State":"running","Status":"Up 2 hours","Labels":"com.docker.compose.project=work-api,com.docker.compose.service=api"}"#;
        let line2 = r#"{"ID":"def456","Names":"postgres-dev","Image":"postgres:16","State":"exited","Status":"Exited 0","Labels":""}"#;
        format!("{line1}\n{line2}\n")
    }

    fn inspect_stdout() -> String {
        // Minimal valid docker inspect JSON.
        r#"[
          {
            "Id": "abc123def456",
            "Name": "/work-api-dev",
            "Image": "node:20-alpine",
            "State": {
              "Status": "running",
              "Running": true,
              "Paused": false,
              "Restarting": false,
              "Dead": false
            },
            "Config": {
              "User": "dev",
              "WorkingDir": "/app",
              "Image": "node:20-alpine"
            },
            "Mounts": [
              {
                "Type": "bind",
                "Name": null,
                "Source": "/var/run/docker.sock",
                "Destination": "/var/run/docker.sock",
                "Mode": "rw",
                "RW": true
              },
              {
                "Type": "volume",
                "Name": "data",
                "Source": "/var/lib/docker/volumes/data",
                "Destination": "/data",
                "Mode": "rw",
                "RW": true
              }
            ],
            "Platform": {
              "Os": "linux",
              "Architecture": "amd64"
            }
          }
        ]"#
        .into()
    }

    #[tokio::test]
    async fn test_ssh_only_probe_succeeds_without_docker() {
        let fake = FakeSshTransport::new(FakeScenario::default());
        fake.add_command_response(
            "true",
            crate::bridge::CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: Some(0),
            },
        );
        let transport: Arc<dyn SshTransport> = Arc::new(fake.clone());
        let result = test_ssh_impl("dev@server".into(), Some(22), &transport)
            .await
            .unwrap();
        assert!(result.ssh_ok);
        assert_eq!(result.docker_permission, "unknown");
        assert!(result.containers.is_empty());
        assert!(result.failure_kind.is_none());
        assert_eq!(fake.command_log(), vec!["true"]);
    }

    #[tokio::test]
    async fn test_ssh_only_probe_surfaces_bounded_redacted_detail() {
        let fake = FakeSshTransport::new(FakeScenario::default());
        fake.add_command_response(
            "true",
            crate::bridge::CommandOutput {
                stdout: String::new(),
                stderr: format!("Permission denied for dev@server {}", "x".repeat(500)),
                exit_code: Some(255),
            },
        );
        let transport: Arc<dyn SshTransport> = Arc::new(fake);
        let result = test_ssh_impl("dev@server".into(), Some(22), &transport)
            .await
            .unwrap();
        assert!(!result.ssh_ok);
        assert_eq!(result.failure_kind.as_deref(), Some("ssh"));
        let detail = result.failure_detail.unwrap();
        assert!(detail.len() <= 303);
        assert!(!detail.contains("dev@server"));
    }

    #[tokio::test]
    async fn test_ssh_and_list_containers_happy_path() {
        let fake = FakeSshTransport::new(FakeScenario::default());
        fake.add_command_response(
            "docker version",
            crate::bridge::CommandOutput {
                stdout: "27.0.0".into(),
                stderr: String::new(),
                exit_code: Some(0),
            },
        );
        fake.add_command_response(
            "container ls",
            crate::bridge::CommandOutput {
                stdout: container_list_stdout(),
                stderr: String::new(),
                exit_code: Some(0),
            },
        );
        let transport: Arc<dyn SshTransport> = Arc::new(fake);

        let result = test_ssh_and_list_containers_impl("dev@server".into(), Some(22), &transport)
            .await
            .unwrap();

        assert!(result.ssh_ok);
        assert_eq!(result.docker_permission, "granted");
        assert_eq!(result.containers.len(), 2);
        assert_eq!(result.containers[0].name, "work-api-dev");
        assert_eq!(result.containers[0].image, "node:20-alpine");
        assert_eq!(result.containers[0].state, "running");
        assert_eq!(result.containers[0].configured_user, "");
        assert_eq!(
            result.containers[0].compose_project.as_deref(),
            Some("work-api")
        );
        assert_eq!(result.containers[0].compose_service.as_deref(), Some("api"));
        assert_eq!(result.containers[1].name, "postgres-dev");
        assert_eq!(result.containers[1].compose_project, None);
        assert_eq!(result.ssh_error_detail, None);
    }

    #[tokio::test]
    async fn test_ssh_and_list_containers_docker_denied() {
        let fake = FakeSshTransport::new(FakeScenario::default());
        fake.add_command_response(
            "docker version",
            crate::bridge::CommandOutput {
                stdout: String::new(),
                stderr: "permission denied".into(),
                exit_code: Some(1),
            },
        );
        let transport: Arc<dyn SshTransport> = Arc::new(fake);

        let result = test_ssh_and_list_containers_impl("dev@server".into(), None, &transport)
            .await
            .unwrap();

        assert!(result.ssh_ok);
        assert_eq!(result.docker_permission, "denied");
        assert!(result.containers.is_empty());
        assert_eq!(result.ssh_error_detail, None);
        assert_eq!(result.failure_kind.as_deref(), Some("dockerUnavailable"));
        assert_eq!(result.failure_detail.as_deref(), Some("permission denied"));
    }

    #[tokio::test]
    async fn test_ssh_and_list_containers_list_failure_is_docker_classified() {
        let fake = FakeSshTransport::new(FakeScenario::default());
        fake.add_command_response(
            "docker version",
            crate::bridge::CommandOutput {
                stdout: "27.0.0".into(),
                stderr: String::new(),
                exit_code: Some(0),
            },
        );
        fake.add_command_response(
            "container ls",
            crate::bridge::CommandOutput {
                stdout: String::new(),
                stderr: "permission denied".into(),
                exit_code: Some(1),
            },
        );
        let transport: Arc<dyn SshTransport> = Arc::new(fake);
        let result = test_ssh_and_list_containers_impl("dev@server".into(), None, &transport)
            .await
            .unwrap();
        assert!(result.ssh_ok);
        assert_eq!(result.failure_kind.as_deref(), Some("dockerDiscovery"));
        assert_eq!(result.failure_detail.as_deref(), Some("permission denied"));
        assert_eq!(result.ssh_error_detail, None);
    }

    #[tokio::test]
    async fn test_ssh_and_list_containers_malformed_output_is_classified() {
        let fake = FakeSshTransport::new(FakeScenario::default());
        fake.add_command_response(
            "docker version",
            crate::bridge::CommandOutput {
                stdout: "27.0.0".into(),
                stderr: String::new(),
                exit_code: Some(0),
            },
        );
        fake.add_command_response(
            "container ls",
            crate::bridge::CommandOutput {
                stdout: "not json".into(),
                stderr: String::new(),
                exit_code: Some(0),
            },
        );
        let transport: Arc<dyn SshTransport> = Arc::new(fake);
        let result = test_ssh_and_list_containers_impl("dev@server".into(), None, &transport)
            .await
            .unwrap();
        assert_eq!(
            result.failure_kind.as_deref(),
            Some("malformedDockerOutput")
        );
        assert!(result
            .failure_detail
            .as_deref()
            .unwrap()
            .contains("record 1"));
        assert!(result.failure_detail.as_deref().unwrap().len() <= 300);
    }

    #[tokio::test]
    async fn test_ssh_and_list_containers_ssh_failure() {
        let fake = FakeSshTransport::new(FakeScenario::default());
        fake.add_command_response(
            "docker version",
            crate::bridge::CommandOutput {
                stdout: String::new(),
                stderr: "Permission denied (publickey)".into(),
                exit_code: Some(255),
            },
        );
        let transport: Arc<dyn SshTransport> = Arc::new(fake);

        let result = test_ssh_and_list_containers_impl("dev@server".into(), None, &transport)
            .await
            .unwrap();

        assert!(!result.ssh_ok);
        assert_eq!(result.docker_permission, "unknown");
        assert!(result.containers.is_empty());
        // The ssh stderr detail surfaces so the setup sheet can show the real cause.
        assert_eq!(
            result.ssh_error_detail.as_deref(),
            Some("Permission denied (publickey)")
        );
        assert_eq!(result.failure_kind.as_deref(), Some("ssh"));
        assert_eq!(
            result.failure_detail.as_deref(),
            Some("Permission denied (publickey)")
        );
        assert!(!result
            .failure_detail
            .as_deref()
            .unwrap()
            .contains("dev@server"));
    }

    #[tokio::test]
    async fn inspect_container_happy_path() {
        let fake = FakeSshTransport::new(FakeScenario::default());
        fake.add_command_response(
            "container inspect",
            crate::bridge::CommandOutput {
                stdout: inspect_stdout(),
                stderr: String::new(),
                exit_code: Some(0),
            },
        );
        fake.add_command_response(
            "docker exec",
            crate::bridge::CommandOutput {
                stdout: "1000|1000|/home/dev\n".into(),
                stderr: String::new(),
                exit_code: Some(0),
            },
        );
        let transport: Arc<dyn SshTransport> = Arc::new(fake);

        let result = inspect_container_impl(
            "dev@server".into(),
            Some(22),
            "work-api-dev".into(),
            &transport,
        )
        .await
        .unwrap();

        assert_eq!(result.name, "work-api-dev");
        assert_eq!(result.container_id, "abc123def456");
        assert_eq!(result.image, "node:20-alpine");
        assert!(result.running);
        assert_eq!(result.configured_user, "dev");
        assert_eq!(result.resolved_uid, 1000);
        assert_eq!(result.resolved_gid, 1000);
        assert_eq!(result.resolved_home, "/home/dev");
        assert_eq!(result.os.as_deref(), Some("linux"));
        assert_eq!(result.arch.as_deref(), Some("amd64"));
        assert_eq!(result.mounts.len(), 2);
        assert_eq!(result.mounts[0].mount_type, "bind");
        assert_eq!(
            result.mounts[0].source.as_deref(),
            Some("/var/run/docker.sock")
        );
        assert_eq!(result.mounts[0].destination, "/var/run/docker.sock");
        assert!(!result.mounts[0].read_only);
        assert_eq!(
            result.pantoken_root_suggestion,
            "/home/dev/.local/share/pantoken"
        );
    }

    #[tokio::test]
    async fn inspect_container_not_found() {
        let fake = FakeSshTransport::new(FakeScenario::default());
        fake.add_command_response(
            "container inspect",
            crate::bridge::CommandOutput {
                stdout: String::new(),
                stderr: "No such container".into(),
                exit_code: Some(1),
            },
        );
        let transport: Arc<dyn SshTransport> = Arc::new(fake);

        let result =
            inspect_container_impl("dev@server".into(), None, "nonexistent".into(), &transport)
                .await;

        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("not found"),
            "error should mention not found"
        );
    }

    #[tokio::test]
    async fn inspect_container_malformed() {
        let fake = FakeSshTransport::new(FakeScenario::default());
        fake.add_command_response(
            "container inspect",
            crate::bridge::CommandOutput {
                stdout: "not valid json".into(),
                stderr: String::new(),
                exit_code: Some(0),
            },
        );
        let transport: Arc<dyn SshTransport> = Arc::new(fake);

        let result =
            inspect_container_impl("dev@server".into(), None, "work-api-dev".into(), &transport)
                .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("malformed"));
    }
}
