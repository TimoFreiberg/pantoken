//! Shared app state, managed by Tauri and reached from tray handlers / event threads.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::config::PantokenConfig;
use crate::remote_connection::RemoteConnection;
use crate::shell::Overlay;
use crate::supervisor::Supervisor;

/// A running remote bridge session: the bridge task handle + its cancellation
/// token + the connection state machine + the loopback port the bridge is
/// listening on. Held by [`AppState`] in a `HashMap` keyed by remote profile id,
/// so multiple remote computers can hold live bridge sessions simultaneously.
pub struct RemoteSession {
    /// The bridge task's JoinHandle — awaited with a bounded timeout on teardown.
    pub handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Cancellation token — signals the bridge's `run()` loop to stop
    /// accepting new connections and shut down.
    pub cancel: tokio_util::sync::CancellationToken,
    /// The connection state machine, driven by the bridge via the
    /// [`ConnectionStateSink`] trait. Read synchronously by the host-state
    /// command layer (`host_state()` / `list_hosts()`).
    pub connection: Arc<RemoteConnection>,
    /// The loopback port the bridge is listening on. Used by
    /// `host_state_impl`/`list_hosts_impl` to build the `wsUrl` field of
    /// `HostStateSnapshot`.
    pub bridge_port: u16,
}

impl RemoteSession {
    /// Teardown: signal cancellation, then await the bridge handle with a
    /// bounded timeout (then abort if it hasn't exited). Idempotent.
    ///
    /// The await runs on a dedicated blocking thread (not the bridge runtime's
    /// worker pool) so it's safe to call from any context — a Tauri worker
    /// thread, the sigwait thread, or a `#[tokio::test]`. The bridge's `run()`
    /// loop exits promptly on cancellation; the 2s timeout is a failsafe
    /// against a stuck relay task.
    pub fn stop(&self, remote_handle: &tokio::runtime::Handle) {
        self.cancel.cancel();
        if let Ok(mut guard) = self.handle.lock() {
            if let Some(handle) = guard.take() {
                // Spawn a blocking thread that awaits the handle on the
                // bridge runtime with a 2s timeout. This avoids
                // "Cannot start a runtime from within a runtime" when stop()
                // is called from inside a tokio worker (tests / async Tauri
                // commands). If the timeout fires, the runtime's shutdown
                // reaps the task (the SSH child is killed via kill_on_drop
                // when the task is dropped).
                let h = remote_handle.clone();
                let timed_out = std::thread::spawn(move || {
                    h.block_on(async {
                        tokio::time::timeout(std::time::Duration::from_secs(2), handle)
                            .await
                            .is_err()
                    })
                })
                .join()
                .unwrap_or(false);
                if timed_out {
                    eprintln!(
                        "pantoken: bridge task didn't exit within 2s — runtime \
                         shutdown will reap it (SSH child killed via kill_on_drop)"
                    );
                }
            }
        }
    }
}

pub struct AppState {
    pub config: Arc<PantokenConfig>,
    pub supervisor: Mutex<Option<Supervisor>>,
    pub overlay: Overlay,
    /// Quit signal for the bundled-mode updater loop (a plain detached thread — this
    /// keeps it from starting an install/relaunch while teardown is in flight).
    pub updater_stop: Arc<AtomicBool>,
    /// The dedicated multi-thread tokio runtime for the bridge + SSH child
    /// process. Tauri's internal `async_runtime` is sized for short plugin
    /// operations, not a persistent listener + long-running child; this runtime
    /// owns those. Built at startup, dropped (and thus shut down) in teardown
    /// AFTER the remote sessions stop.
    pub remote_runtime: Mutex<Option<tokio::runtime::Runtime>>,
    /// The handle into [`remote_runtime`] (cheap to clone; the runtime itself
    /// stays in the mutex so teardown drops it).
    pub remote_handle: tokio::runtime::Handle,
    /// Active remote bridge sessions, keyed by remote profile id. Multiple
    /// remote computers can hold live bridge sessions simultaneously. Starting
    /// profile B does NOT stop profile A; disconnecting B stops only B;
    /// teardown stops all. The local computer is NOT in this map — it's the
    /// `Supervisor`.
    pub remote: Mutex<HashMap<String, Arc<RemoteSession>>>,
}

impl AppState {
    pub fn new(config: PantokenConfig) -> Self {
        // Build the dedicated tokio runtime for the bridge. Multi-thread so the
        // bridge's accept loop, SSH relay tasks, and child process can all run
        // without starving each other. enable_all() for IO + time + process.
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("pantoken-bridge")
            .build()
            .expect("failed to build bridge tokio runtime");
        let handle = runtime.handle().clone();

        Self {
            config: Arc::new(config),
            supervisor: Mutex::new(None),
            overlay: Overlay::new(),
            updater_stop: Arc::new(AtomicBool::new(false)),
            remote_runtime: Mutex::new(Some(runtime)),
            remote_handle: handle,
            remote: Mutex::new(HashMap::new()),
        }
    }

    /// Stop the updater loop first (so it can't start an install/relaunch mid-teardown),
    /// then all remote sessions (bridge + SSH child), then the supervisor
    /// (SIGTERM → bounded wait → SIGKILL). Finally drop the bridge runtime.
    /// Idempotent: each flag is sticky and each handle is take()n.
    pub fn teardown(&self) {
        self.updater_stop.store(true, Ordering::SeqCst);
        // Stop all remote sessions, then clear the map.
        let sessions: Vec<Arc<RemoteSession>> = self
            .remote
            .lock()
            .unwrap()
            .drain()
            .map(|(_, s)| s)
            .collect();
        for session in sessions {
            session.stop(&self.remote_handle);
        }
        if let Some(mut s) = self.supervisor.lock().unwrap().take() {
            s.stop();
        }
        // Drop the runtime last — its threads host the bridge tasks. Dropping
        // shuts the worker threads down cleanly (they've already exited by now
        // because the sessions are stopped).
        if let Some(rt) = self.remote_runtime.lock().unwrap().take() {
            rt.shutdown_background();
        }
    }

    /// Remove + stop one remote session by profile id. Idempotent (no-op if the
    /// id is not present). Does NOT navigate the WebView.
    pub fn stop_remote(&self, id: &str) {
        if let Some(session) = self.remote.lock().unwrap().remove(id) {
            session.connection.disconnect();
            session.stop(&self.remote_handle);
        }
    }

    /// Read a session's connection state machine without holding the map lock
    /// longer than needed (clone the `Arc<RemoteConnection>`, drop the lock).
    pub fn get_remote(&self, id: &str) -> Option<Arc<RemoteConnection>> {
        self.remote
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.connection.clone())
    }

    /// Read a session's bridge port without holding the map lock longer than
    /// needed.
    pub fn get_remote_bridge_port(&self, id: &str) -> Option<u16> {
        self.remote.lock().unwrap().get(id).map(|s| s.bridge_port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two sessions can coexist in the map; stopping one leaves the other.
    #[test]
    fn stop_remote_removes_only_one_leaving_others() {
        let config = PantokenConfig::fallback(0);
        let state = AppState::new(config);

        // Insert two dummy sessions (no real bridge task — just the connection).
        let conn_a = Arc::new(RemoteConnection::new());
        let conn_b = Arc::new(RemoteConnection::new());
        {
            let mut map = state.remote.lock().unwrap();
            map.insert(
                "a".into(),
                Arc::new(RemoteSession {
                    handle: Mutex::new(None),
                    cancel: tokio_util::sync::CancellationToken::new(),
                    connection: conn_a.clone(),
                    bridge_port: 10001,
                }),
            );
            map.insert(
                "b".into(),
                Arc::new(RemoteSession {
                    handle: Mutex::new(None),
                    cancel: tokio_util::sync::CancellationToken::new(),
                    connection: conn_b.clone(),
                    bridge_port: 10002,
                }),
            );
        }

        // Stop only "b".
        state.stop_remote("b");

        {
            let map = state.remote.lock().unwrap();
            assert!(map.contains_key("a"), "A should still be in the map");
            assert!(!map.contains_key("b"), "B should be removed");
        }

        // A's connection is untouched (Disconnected, since begin() was never called).
        assert_eq!(
            conn_a.state(),
            crate::remote_connection::ConnectionState::Disconnected
        );
        // B's connection was disconnected().
        assert_eq!(
            conn_b.state(),
            crate::remote_connection::ConnectionState::Disconnected
        );
    }

    /// Teardown stops all sessions and clears the map.
    #[test]
    fn teardown_clears_all_sessions() {
        let config = PantokenConfig::fallback(0);
        let state = AppState::new(config);

        {
            let mut map = state.remote.lock().unwrap();
            map.insert(
                "a".into(),
                Arc::new(RemoteSession {
                    handle: Mutex::new(None),
                    cancel: tokio_util::sync::CancellationToken::new(),
                    connection: Arc::new(RemoteConnection::new()),
                    bridge_port: 10001,
                }),
            );
            map.insert(
                "b".into(),
                Arc::new(RemoteSession {
                    handle: Mutex::new(None),
                    cancel: tokio_util::sync::CancellationToken::new(),
                    connection: Arc::new(RemoteConnection::new()),
                    bridge_port: 10002,
                }),
            );
        }

        state.teardown();

        let map = state.remote.lock().unwrap();
        assert!(map.is_empty(), "map should be empty after teardown");
    }

    /// `get_remote` clones the Arc without holding the lock.
    #[test]
    fn get_remote_returns_connection_arc() {
        let config = PantokenConfig::fallback(0);
        let state = AppState::new(config);
        let conn = Arc::new(RemoteConnection::new());
        state.remote.lock().unwrap().insert(
            "x".into(),
            Arc::new(RemoteSession {
                handle: Mutex::new(None),
                cancel: tokio_util::sync::CancellationToken::new(),
                connection: conn.clone(),
                bridge_port: 12345,
            }),
        );

        let got = state.get_remote("x").expect("should find x");
        assert!(Arc::ptr_eq(&got, &conn));
        assert!(state.get_remote("missing").is_none());
        assert_eq!(state.get_remote_bridge_port("x"), Some(12345));
    }
}
