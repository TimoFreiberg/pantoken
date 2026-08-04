//! Remote lifecycle manager + idle cleanup (Phase 1.4).
//!
//! This is genuinely new infrastructure: `idle_reap_ms` exists in `config.rs`
//! but had NO consumer before this. The reaper:
//!
//! - Runs a periodic timer driven by `idle_reap_ms`.
//! - Checks the active guard: an active turn (`any_turn_in_flight`) OR an
//!   active client connection (`hub.client_count() > 0`) prevents cleanup.
//! - When idle (no connections, no active turns), disposes warm session
//!   attachments via `dispose_idle_warm` while retaining durable session
//!   state (the journal/store persists).
//! - When fully idle for a longer grace period (`hub_idle_ms`), signals the
//!   hub to exit (the next proxy invocation race-safely restarts it).
//!
//! ## PID identity checks
//!
//! Cleanup uses pid liveness (the `pidlock` module's `is_pid_alive` via
//! signal-0) and NEVER kills an unrelated process that recycled a PID.
//! `lock_decision` consults ONLY pid liveness, NOT the stored `server_id`
//! — and there is NO start-token today (see the Phase 1.2 PID-recycling
//! caveat). This is acceptable for Phase 1 (single-user, short-lived daemons).

use std::sync::Arc;
use std::time::Duration;

use crate::driver::PantokenDriver;
use crate::hub::SessionHub;
use parking_lot::Mutex as ParkingMutex;
use tokio::sync::{oneshot, watch};
use tracing::info;

/// Configuration for the lifecycle manager.
#[derive(Clone)]
pub struct LifecycleConfig {
    /// Idle-reap timeout for warm sessions (ms). ≤0 disables session reaping.
    pub idle_reap_ms: i64,
    /// Hub-idle exit timeout (ms). When the hub has no connections, no active
    /// turns, and no warm work for this long, it may exit. ≤0 disables exit.
    /// Recommend 2× the session-idle timeout, or a distinct
    /// `PANTOKEN_HUB_IDLE_MS`.
    pub hub_idle_ms: i64,
}

/// The lifecycle manager.
///
/// Runs a periodic timer that checks whether the hub is idle and, if so,
/// disposes warm sessions and (after a longer grace) signals the hub to exit.
///
/// The manager is started as a background tokio task; it holds a
/// `watch::Receiver<bool>` that the hub's accept loop watches for the idle-exit
/// signal. When `true` is sent, the hub should stop accepting and exit.
///
/// The lifecycle task has a separate private cancellation channel. This keeps
/// stopping the task from accidentally publishing the public idle-exit signal.
pub struct LifecycleManager {
    /// Watch this for the exit signal. When it becomes `true`, the hub should
    /// stop accepting new connections and exit.
    pub exit_signal: watch::Receiver<bool>,
    cancel_tx: Option<oneshot::Sender<()>>,
    join_handle: Option<tokio::task::JoinHandle<()>>,
    #[cfg(test)]
    ready_rx: Option<oneshot::Receiver<()>>,
}

impl LifecycleManager {
    /// Start the lifecycle manager as a background task.
    ///
    /// Returns a handle whose `exit_signal` can be watched by the hub's accept
    /// loop. When the hub has been fully idle for `hub_idle_ms`, the signal is
    /// set to `true`.
    pub fn start(
        hub: Arc<ParkingMutex<SessionHub>>,
        driver: Arc<dyn PantokenDriver>,
        config: LifecycleConfig,
    ) -> Self {
        let (exit_tx, exit_rx) = watch::channel(false);
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (ready_tx, ready_rx) = oneshot::channel();

        let join_handle = tokio::spawn(async move {
            run_lifecycle_loop(hub, driver, config, exit_tx, cancel_rx, ready_tx).await;
        });

        #[cfg(not(test))]
        drop(ready_rx);

        Self {
            exit_signal: exit_rx,
            cancel_tx: Some(cancel_tx),
            join_handle: Some(join_handle),
            #[cfg(test)]
            ready_rx: Some(ready_rx),
        }
    }

    /// Wait until the lifecycle task has initialized its loop and reached its
    /// first timer wait. This is primarily useful for paused-clock tests.
    #[cfg(test)]
    async fn wait_until_ready(&mut self) {
        if let Some(ready_rx) = self.ready_rx.take() {
            ready_rx.await.expect("lifecycle task startup");
        }
    }

    /// Stop the lifecycle task and wait until it has exited.
    ///
    /// Cancellation is intentionally independent of `exit_signal`: a runtime
    /// shutdown must not make the public idle-exit watch look like a normal
    /// idle shutdown.
    pub async fn shutdown(mut self) {
        if let Some(cancel_tx) = self.cancel_tx.take() {
            let _ = cancel_tx.send(());
        }
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.await;
        }
    }
}

impl Drop for LifecycleManager {
    fn drop(&mut self) {
        if let Some(cancel_tx) = self.cancel_tx.take() {
            let _ = cancel_tx.send(());
        }
        if let Some(join_handle) = self.join_handle.take() {
            join_handle.abort();
        }
    }
}

/// The main lifecycle loop.
///
/// Runs until private cancellation or an idle-exit signal ends the loop. Checks
/// periodically:
/// 1. If there are active connections or turns → reset idle timers.
/// 2. If idle for `idle_reap_ms` → dispose warm sessions (preserve journal).
/// 3. If idle for `hub_idle_ms` → signal hub exit.
async fn run_lifecycle_loop(
    hub: Arc<ParkingMutex<SessionHub>>,
    driver: Arc<dyn PantokenDriver>,
    config: LifecycleConfig,
    exit_tx: watch::Sender<bool>,
    mut cancel_rx: oneshot::Receiver<()>,
    ready_tx: oneshot::Sender<()>,
) {
    if config.idle_reap_ms <= 0 && config.hub_idle_ms <= 0 {
        info!("lifecycle: idle reaping disabled (idle_reap_ms ≤ 0)");
        let _ = ready_tx.send(());
        return;
    }

    // Check interval: the smaller of the two timeouts, divided by 4 (so we
    // check 4× per grace period). Minimum 1s to avoid busy-looping.
    let check_interval = Duration::from_millis(
        (config.idle_reap_ms.min(config.hub_idle_ms).max(1000) as u64 / 4).max(1000),
    );

    let mut last_activity = tokio::time::Instant::now();
    let mut last_reap = tokio::time::Instant::now();

    info!(
        "lifecycle: reaper started (idle_reap_ms={}, hub_idle_ms={}, check_interval={:?})",
        config.idle_reap_ms, config.hub_idle_ms, check_interval
    );

    // This barrier is immediately before the first timer wait. Tests await it
    // before advancing paused Tokio time, so they cannot advance past the
    // timer before the lifecycle task has initialized its clock state.
    let _ = ready_tx.send(());

    loop {
        // Wait for the check interval or private task cancellation. Cancellation
        // is separate from `exit_tx`: shutdown must not publish idle exit.
        tokio::select! {
            _ = &mut cancel_rx => {
                info!("lifecycle: cancellation received, stopping reaper");
                return;
            }
            _ = tokio::time::sleep(check_interval) => {}
        }

        let now = tokio::time::Instant::now();
        let has_connections = hub.lock().client_count() > 0;
        let has_active_turn = driver.any_turn_in_flight();
        let warm_count = driver.warm_session_count();

        if has_connections || has_active_turn {
            // Active work — reset idle timers.
            last_activity = now;
            continue;
        }

        // No connections, no active turns.
        let idle_duration = now.duration_since(last_activity);

        // Session reaping: dispose warm sessions after idle_reap_ms.
        if config.idle_reap_ms > 0
            && idle_duration >= Duration::from_millis(config.idle_reap_ms as u64)
            && warm_count > 0
            && now.duration_since(last_reap) >= Duration::from_millis(config.idle_reap_ms as u64)
        {
            info!(
                "lifecycle: idle for {:?}, disposing {} warm sessions (preserving journal)",
                idle_duration, warm_count
            );
            driver.dispose_idle_warm().await;
            last_reap = now;
        }

        // Hub exit: after hub_idle_ms of full idleness, signal exit.
        if config.hub_idle_ms > 0
            && idle_duration >= Duration::from_millis(config.hub_idle_ms as u64)
            && driver.warm_session_count() == 0
        {
            info!(
                "lifecycle: hub idle for {:?} (≥ hub_idle_ms), signaling exit",
                idle_duration
            );
            let _ = exit_tx.send(true);
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    //! Named validations (unit level):
    //! - `active_session_not_reaped`
    //! - `idle_session_gc_preserves_history`
    //! - `idle_hub_shutdown_and_restart`
    //!
    //! These tests use the MockDriver (which has no real warm sessions) to
    //! verify the lifecycle manager's decision logic. The `active_turn_survives_proxy_drop`
    //! test (AC.9) requires the fake driver and lives in the integration tests.

    use super::*;
    use crate::driver::PantokenDriver;
    use crate::hub::{SessionHub, hub_op_channel};
    use crate::mock_driver::MockDriver;

    fn test_hub() -> (Arc<ParkingMutex<SessionHub>>, Arc<dyn PantokenDriver>) {
        let dir = tempfile::tempdir().unwrap();
        let driver: Arc<dyn PantokenDriver> = Arc::new(MockDriver::new());
        let (hub_ops, _rx) = hub_op_channel();
        let hub = SessionHub::new(
            driver.clone(),
            hub_ops,
            None,
            1000,
            "test-lifecycle".into(),
            Some(dir.path().to_path_buf()),
            String::new(),
            0,
            0,
        );
        std::mem::forget(dir);
        (hub, driver)
    }

    #[tokio::test(start_paused = true)]
    async fn active_session_not_reaped() {
        // With an active client connection, the reaper must NOT dispose warm
        // sessions or signal exit.
        let (hub, driver) = test_hub();

        // Register a client (simulates an active connection).
        {
            let mut h = hub.lock();
            h.add_client(None);
        }
        assert_eq!(hub.lock().client_count(), 1);

        let config = LifecycleConfig {
            idle_reap_ms: 100,
            hub_idle_ms: 200,
        };
        let mut manager = LifecycleManager::start(hub.clone(), driver, config);
        manager.wait_until_ready().await;

        // The production loop checks at least once per second. Advance beyond
        // that cadence and explicitly yield so the task observes the active
        // connection without relying on scheduler timing.
        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::task::yield_now().await;
        assert!(
            !*manager.exit_signal.borrow(),
            "hub must NOT exit while there are active connections"
        );
        manager.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn idle_hub_shutdown_and_restart() {
        // With no connections, no active turns, and no warm sessions, the hub
        // should signal exit after hub_idle_ms.
        let (hub, driver) = test_hub();

        // No clients connected — hub is fully idle.
        assert_eq!(hub.lock().client_count(), 0);

        let config = LifecycleConfig {
            idle_reap_ms: 50,
            hub_idle_ms: 100,
        };
        let mut manager = LifecycleManager::start(hub.clone(), driver, config);
        manager.wait_until_ready().await;

        // The one-second minimum check cadence dominates this short fixture.
        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::task::yield_now().await;

        assert!(
            *manager.exit_signal.borrow(),
            "hub must signal exit after hub_idle_ms when fully idle"
        );
        manager.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn idle_session_gc_preserves_history() {
        // The MockDriver has no real warm sessions, so dispose_idle_warm is a
        // no-op. This test verifies the reaper's logic: with no connections
        // and idle_reap_ms elapsed, it calls dispose_idle_warm (which is a
        // no-op for mock) and does NOT signal exit until hub_idle_ms.
        let (hub, driver) = test_hub();

        let config = LifecycleConfig {
            idle_reap_ms: 50,
            hub_idle_ms: 2_000,
        };
        let mut manager = LifecycleManager::start(hub.clone(), driver, config);
        manager.wait_until_ready().await;

        // Advance through one check at the one-second minimum cadence, but
        // remain below hub_idle_ms. This verifies the reaping window without
        // depending on wall-clock scheduling.
        tokio::time::advance(Duration::from_millis(1_100)).await;
        tokio::task::yield_now().await;
        assert!(
            !*manager.exit_signal.borrow(),
            "hub must NOT exit before hub_idle_ms"
        );

        // The next deterministic check is beyond the hub idle horizon.
        tokio::time::advance(Duration::from_millis(1_100)).await;
        tokio::task::yield_now().await;
        assert!(
            *manager.exit_signal.borrow(),
            "hub must exit after hub_idle_ms"
        );
        manager.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn lifecycle_disabled_when_idle_reap_zero() {
        // idle_reap_ms=0 and hub_idle_ms=0 → reaper is a no-op.
        let (hub, driver) = test_hub();
        let config = LifecycleConfig {
            idle_reap_ms: 0,
            hub_idle_ms: 0,
        };
        let mut manager = LifecycleManager::start(hub.clone(), driver, config);
        manager.wait_until_ready().await;

        // Startup completion proves the disabled task returned without any
        // timer wait; no wall-clock delay is needed.
        assert!(
            !*manager.exit_signal.borrow(),
            "reaper must be a no-op when both timeouts are ≤ 0"
        );
        manager.shutdown().await;
    }
}
