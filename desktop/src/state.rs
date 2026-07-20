//! Shared app state, managed by Tauri and reached from tray handlers / event threads.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::config::PantokenConfig;
use crate::remote_connection::RemoteConnection;
use crate::shell::Overlay;
use crate::supervisor::Supervisor;

/// A running remote bridge session: the bridge task handle + its cancellation
/// token + the connection state machine. Held by [`AppState`] under a mutex
/// so `connect_to_remote` is exclusive (a second call tears down the first).
pub struct RemoteSession {
    /// The bridge task's JoinHandle — awaited with a bounded timeout on teardown.
    pub handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Cancellation token — signals the bridge's `run()` loop to stop
    /// accepting new connections and shut down.
    pub cancel: tokio_util::sync::CancellationToken,
    /// The connection state machine, driven by the bridge via the
    /// [`ConnectionStateSink`] trait. Read synchronously by the Tauri command
    /// layer (`remote_connection_state()`).
    pub connection: Arc<RemoteConnection>,
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
    /// AFTER the remote session stops.
    pub remote_runtime: Mutex<Option<tokio::runtime::Runtime>>,
    /// The handle into [`remote_runtime`] (cheap to clone; the runtime itself
    /// stays in the mutex so teardown drops it).
    pub remote_handle: tokio::runtime::Handle,
    /// The active remote session, if any. `connect_to_remote` is exclusive: a
    /// second call tears down the first before starting a new one.
    pub remote: Mutex<Option<Arc<RemoteSession>>>,
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
            remote: Mutex::new(None),
        }
    }

    /// Stop the updater loop first (so it can't start an install/relaunch mid-teardown),
    /// then the remote session (bridge + SSH child), then the supervisor
    /// (SIGTERM → bounded wait → SIGKILL). Finally drop the bridge runtime.
    /// Idempotent: each flag is sticky and each handle is take()n.
    pub fn teardown(&self) {
        self.updater_stop.store(true, Ordering::SeqCst);
        if let Some(session) = self.remote.lock().unwrap().take() {
            session.stop(&self.remote_handle);
        }
        if let Some(mut s) = self.supervisor.lock().unwrap().take() {
            s.stop();
        }
        // Drop the runtime last — its threads host the bridge tasks. Dropping
        // shuts the worker threads down cleanly (they've already exited by now
        // because the session is stopped).
        if let Some(rt) = self.remote_runtime.lock().unwrap().take() {
            rt.shutdown_background();
        }
    }
}
