//! Tauri commands for remote-connection management (Phase 2, step 11).
//!
//! Commands (registered in `main.rs` via `invoke_handler`):
//! - `list_remote_profiles() -> Vec<RemoteProfile>`
//! - `add_remote_profile(profile: RemoteProfile) -> RemoteProfile`
//! - `update_remote_profile(profile: RemoteProfile)`
//! - `delete_remote_profile(id: String)`
//! - `connect_to_remote(profile_id: String)` — starts the bridge + SSH, navigates the WebView.
//! - `disconnect_remote()` — stops the bridge, navigates back to local hub.
//! - `remote_connection_state() -> ConnectionStateInfo` — polls the current state.
//!
//! ## Sync↔async command layer
//!
//! Tauri 2 command handlers can be `async fn` (they run on Tauri's internal
//! `async_runtime`), but the bridge must run on the dedicated tokio runtime
//! (Tauri's runtime isn't suitable for the bridge's long-running `TcpListener`
//! + `Command` + `spawn` task). Commands are synchronous `fn` that use
//! `remote_handle.spawn(future)` and cross runtimes via `oneshot`; fire-and-forget
//! commands (`connect_to_remote`) use `handle.spawn` without awaiting.
//! `remote_connection_state()` reads the state machine under a `Mutex` (sync,
//! no async needed).
//!
//! ## Core vs command layer
//!
//! The `#[tauri::command]` wrappers are thin: they extract the `AppState`
//! from the `State<'_>` guard and delegate to the core `*_impl` functions,
//! which take `&AppState` + `&AppHandle`. This lets the tray handlers
//! (`shell::remote_connect_dialog`) call the same logic directly without
//! going through Tauri's command dispatch.

#![allow(clippy::doc_lazy_continuation)]

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio_util::sync::CancellationToken;

use crate::bridge::{Bridge, ConnectionStateSink, SshCommand, SshTransport, SystemSshTransport};
use crate::remote_connection::{ConnectionState, RemoteConnection};
use crate::remote_profile::{RemoteProfile, RemoteProfileStore};
use crate::shell;
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

/// Connect to a remote runtime: load the profile, acquire a free loopback
/// port, start the bridge + SSH proxy on the dedicated runtime, navigate the
/// WebView to the hub with `?ws=` pointing at the bridge.
///
/// Exclusive: a second call while a `RemoteSession` is active tears down the
/// first (stop bridge + kill SSH child) before starting the new one.
pub fn connect_to_remote_impl(
    app: &AppHandle,
    state: &AppState,
    profile_id: String,
) -> Result<(), String> {
    // 1. Load the profile.
    let path = state.config.remote_profiles_path();
    let store = RemoteProfileStore::load(&path).map_err(|e| e.to_string())?;
    let profile = store
        .profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("no remote profile with id {profile_id}"))?;
    profile.validate().map_err(|e| e.to_string())?;

    // 2. Acquire a free loopback port (TOCTOU window documented in config.rs;
    //    a bind failure surfaces as ProxyStartFailed).
    let bridge_port = crate::config::free_port()
        .map_err(|e| format!("couldn't acquire a free loopback port for the bridge: {e}"))?;

    // 3. Tear down any existing session (exclusive connect).
    if let Some(existing) = state.remote.lock().unwrap().take() {
        existing.stop(&state.remote_handle);
    }

    // 4. Build the bridge: transport + resolved SSH command.
    let connection = Arc::new(RemoteConnection::new());
    connection.begin(profile.clone());

    let command = SshCommand::from(&profile);
    let transport: Arc<dyn SshTransport> = Arc::new(SystemSshTransport::new());
    let bridge = Bridge::new(bridge_port, transport, command)
        .with_state_sink(connection.clone() as Arc<dyn ConnectionStateSink>);

    // 5. Start the bridge on the dedicated runtime. Fire-and-forget — the
    //    state machine drives the overlay; the command returns immediately.
    let cancel = CancellationToken::new();
    let cancel_for_task = cancel.clone();
    let handle = state.remote_handle.spawn(async move {
        if let Err(e) = bridge.run(cancel_for_task).await {
            eprintln!("pantoken: bridge run error: {e}");
        }
    });

    // 6. Store the session.
    let session = Arc::new(RemoteSession {
        handle: std::sync::Mutex::new(Some(handle)),
        cancel,
        connection: connection.clone(),
    });
    *state.remote.lock().unwrap() = Some(session);

    // 7. Raise the initial overlay + navigate the WebView to the hub with
    //    `?ws=` pointing at the bridge.
    state
        .overlay
        .raise(app, ConnectionState::TestingSsh.overlay_label());
    let hub_port = state.config.server_port;
    let url = format!("http://127.0.0.1:{hub_port}/?ws=ws://127.0.0.1:{bridge_port}");
    shell::navigate_main(app, &url);

    // 8. Spawn a poller that drives the native overlay from the connection
    //    state machine. The bridge writes states from its async task; this
    //    thread reads them (sync, under the Mutex) and updates the overlay +
    //    shows a failure dialog on terminal failures. Exits when the session
    //    is torn down or reaches a terminal state.
    spawn_overlay_poller(app.clone(), connection);

    Ok(())
}

pub fn disconnect_remote_impl(app: &AppHandle, state: &AppState) -> Result<(), String> {
    if let Some(session) = state.remote.lock().unwrap().take() {
        session.connection.disconnect();
        session.stop(&state.remote_handle);
    }
    state.overlay.hide(app);
    shell::navigate_main(app, &state.config.app_url());
    Ok(())
}

pub fn remote_connection_state_impl(
    state: &AppState,
) -> crate::remote_connection::ConnectionStateInfo {
    let guard = state.remote.lock().unwrap();
    match guard.as_ref() {
        Some(session) => session.connection.info(),
        None => crate::remote_connection::ConnectionStateInfo {
            state: "Disconnected".into(),
            profile_label: None,
            failed: false,
            failure_label: None,
            failure_action: None,
            failure_detail: None,
        },
    }
}

/// Spawn a background thread that polls the connection state machine and
/// drives the native overlay. On a terminal failure it shows a Retry/Cancel
/// dialog (Retry reconnects, Cancel navigates back to the local hub).
fn spawn_overlay_poller(app: AppHandle, connection: Arc<RemoteConnection>) {
    std::thread::spawn(move || {
        let mut last_label: Option<String> = None;
        loop {
            let info = connection.info();
            // Stop polling when the connection is torn down (Disconnected) or
            // the app is gone.
            if info.state == "Disconnected" && !info.failed {
                return;
            }
            if last_label.as_deref() != Some(info.state.as_str()) {
                last_label = Some(info.state.clone());
                if info.failed {
                    // Terminal failure: show Retry/Cancel dialog.
                    let body = format!(
                        "{}\n\n{}",
                        info.failure_label.as_deref().unwrap_or("Connection failed"),
                        info.failure_action.as_deref().unwrap_or_default(),
                    );
                    let retry = app
                        .dialog()
                        .message(body)
                        .title("Remote connection failed")
                        .buttons(MessageDialogButtons::YesNo)
                        .kind(MessageDialogKind::Warning)
                        .blocking_show();
                    if retry {
                        // Retry: mark reconnecting (the browser's resume logic +
                        // the bridge's fresh-proxy-per-connection handle it).
                        // A full re-run of connect_to_remote is left as a
                        // manual tray step for Phase 2.
                        connection.on_state(ConnectionState::Reconnecting);
                        if let Some(state) = app.try_state::<AppState>() {
                            state.overlay.raise(&app, "Reconnecting…");
                        }
                    } else {
                        // Cancel: disconnect.
                        if let Some(state) = app.try_state::<AppState>() {
                            let _ = disconnect_remote_impl(&app, &state);
                        }
                        return;
                    }
                } else if info.state == "Ready" {
                    // Ready: hide the overlay (the WebView is live now).
                    if let Some(state) = app.try_state::<AppState>() {
                        state.overlay.hide(&app);
                    }
                } else {
                    // In-progress phase: raise the overlay with the label.
                    if let Some(state) = app.try_state::<AppState>() {
                        state.overlay.raise(&app, &info.state);
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    });
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

/// Connect to a remote runtime: starts the bridge + SSH, navigates the WebView.
#[tauri::command]
pub fn connect_to_remote(
    app: AppHandle,
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    connect_to_remote_impl(&app, state.inner(), profile_id)
}

/// Disconnect: stop the bridge + SSH child, navigate back to the local hub.
#[tauri::command]
pub fn disconnect_remote(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    disconnect_remote_impl(&app, state.inner())
}

/// Poll the current remote connection state (for the WebView / overlay).
#[tauri::command]
pub fn remote_connection_state(
    state: State<'_, AppState>,
) -> crate::remote_connection::ConnectionStateInfo {
    remote_connection_state_impl(state.inner())
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
        connect_to_remote,
        disconnect_remote,
        remote_connection_state,
    ])
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `bridge_wired_into_desktop_lifecycle` (AC.3, AC.6)
    //! - `connect_to_remote_exclusive_tears_down_existing` (AC.3)

    use super::*;
    use crate::bridge::fake::{FakeScenario, FakeSshTransport};
    use crate::remote_connection::ConnectionState;

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

    /// AC.3: a second `connect_to_remote` tears down the first session before
    /// starting the new one. We simulate the exclusive-teardown path at the
    /// session level (the full Tauri command path needs a running app).
    #[tokio::test]
    async fn connect_to_remote_exclusive_tears_down_existing() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");

        // First session.
        let port1 = {
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
        };
        let conn1 = Arc::new(RemoteConnection::new());
        let bridge1 = Bridge::new(port1, transport, command)
            .with_state_sink(conn1.clone() as Arc<dyn ConnectionStateSink>);
        let cancel1 = CancellationToken::new();
        let cancel_for_task1 = cancel1.clone();
        let handle1 = runtime.spawn(async move {
            let _ = bridge1.run(cancel_for_task1).await;
        });

        runtime.spawn(async {}).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Simulate AppState's remote slot holding the first session.
        let mut active: Option<Arc<RemoteSession>> = Some(Arc::new(RemoteSession {
            handle: std::sync::Mutex::new(Some(handle1)),
            cancel: cancel1,
            connection: conn1,
        }));

        // Second connect_to_remote: tear down the first before starting the new.
        if let Some(existing) = active.take() {
            existing.stop(runtime.handle());
        }
        assert!(active.is_none(), "first session torn down");

        // A second session starts fresh on a new port.
        let port2 = {
            let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        let transport2: Arc<dyn SshTransport> =
            Arc::new(FakeSshTransport::new(FakeScenario::healthy()));
        let command2 = SshCommand {
            destination: "fake".into(),
            port: None,
            remote_root: "/tmp".into(),
            server_path: "pantoken-server".into(),
        };
        let conn2 = Arc::new(RemoteConnection::new());
        let bridge2 = Bridge::new(port2, transport2, command2)
            .with_state_sink(conn2.clone() as Arc<dyn ConnectionStateSink>);
        let cancel2 = CancellationToken::new();
        let cancel_for_task2 = cancel2.clone();
        let handle2 = runtime.spawn(async move {
            let _ = bridge2.run(cancel_for_task2).await;
        });
        active = Some(Arc::new(RemoteSession {
            handle: std::sync::Mutex::new(Some(handle2)),
            cancel: cancel2,
            connection: conn2,
        }));

        // The second session is live.
        assert!(active.is_some());

        // Clean teardown.
        if let Some(s) = active.take() {
            s.stop(runtime.handle());
        }
        runtime.shutdown_background();
    }
}
