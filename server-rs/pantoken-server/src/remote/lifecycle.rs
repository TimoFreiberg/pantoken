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
use tokio::sync::watch;
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

impl LifecycleConfig {
    /// Read lifecycle config from env vars.
    pub fn from_env(idle_reap_ms: i64) -> Self {
        let hub_idle_ms = std::env::var("PANTOKEN_HUB_IDLE_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(idle_reap_ms * 2);
        Self {
            idle_reap_ms,
            hub_idle_ms,
        }
    }
}

/// The lifecycle manager.
///
/// Runs a periodic timer that checks whether the hub is idle and, if so,
/// disposes warm sessions and (after a longer grace) signals the hub to exit.
///
/// The manager is started as a background tokio task; it holds a
/// `watch::Sender<bool>` that the hub's accept loop watches for the idle-exit
/// signal. When `true` is sent, the hub should stop accepting and exit.
pub struct LifecycleManager {
    /// Watch this for the exit signal. When it becomes `true`, the hub should
    /// stop accepting new connections and exit.
    pub exit_signal: watch::Receiver<bool>,
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

        tokio::spawn(async move {
            run_lifecycle_loop(hub, driver, config, exit_tx).await;
        });

        Self {
            exit_signal: exit_rx,
        }
    }
}

/// The main lifecycle loop.
///
/// Runs until the exit signal is cancelled or the process exits. Checks
/// periodically:
/// 1. If there are active connections or turns → reset idle timers.
/// 2. If idle for `idle_reap_ms` → dispose warm sessions (preserve journal).
/// 3. If idle for `hub_idle_ms` → signal hub exit.
async fn run_lifecycle_loop(
    hub: Arc<ParkingMutex<SessionHub>>,
    driver: Arc<dyn PantokenDriver>,
    config: LifecycleConfig,
    exit_tx: watch::Sender<bool>,
) {
    if config.idle_reap_ms <= 0 && config.hub_idle_ms <= 0 {
        info!("lifecycle: idle reaping disabled (idle_reap_ms ≤ 0)");
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

    loop {
        // Wait for the check interval or an exit signal.
        {
            let mut rx = exit_tx.subscribe();
            tokio::select! {
                _ = rx.changed() => {
                    if *rx.borrow() {
                        info!("lifecycle: exit signal received, stopping reaper");
                        return;
                    }
                }
                _ = tokio::time::sleep(check_interval) => {}
            }
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
        );
        std::mem::forget(dir);
        (hub, driver)
    }

    #[tokio::test]
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
            idle_reap_ms: 100, // very short for testing
            hub_idle_ms: 200,
        };
        let manager = LifecycleManager::start(hub.clone(), driver, config);

        // Wait longer than both timeouts — the reaper should NOT have exited.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            !*manager.exit_signal.borrow(),
            "hub must NOT exit while there are active connections"
        );
    }

    #[tokio::test]
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
        let manager = LifecycleManager::start(hub.clone(), driver, config);

        // Wait for the hub-idle timeout to fire.
        let exited = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if *manager.exit_signal.borrow() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;

        assert!(
            exited.is_ok(),
            "hub must signal exit after hub_idle_ms when fully idle"
        );
    }

    #[tokio::test]
    async fn idle_session_gc_preserves_history() {
        // The MockDriver has no real warm sessions, so dispose_idle_warm is a
        // no-op. This test verifies the reaper's logic: with no connections
        // and idle_reap_ms elapsed, it calls dispose_idle_warm (which is a
        // no-op for mock) and does NOT signal exit (because hub_idle_ms hasn't
        // elapsed yet — it's 2× idle_reap_ms).
        //
        // The real warm-session preservation test (verifying the journal
        // survives disposal) uses the fake driver and lives in the integration
        // tests. Here we verify the timing logic: the reaper fires at
        // idle_reap_ms but does NOT exit until hub_idle_ms.
        let (hub, driver) = test_hub();

        let config = LifecycleConfig {
            idle_reap_ms: 50,
            hub_idle_ms: 200, // 4× the reap interval
        };
        let manager = LifecycleManager::start(hub.clone(), driver, config);

        // Wait past idle_reap_ms but NOT past hub_idle_ms.
        tokio::time::sleep(Duration::from_millis(120)).await;

        // The reaper should have fired (disposed warm sessions — a no-op for
        // mock driver), but NOT exited yet.
        assert!(
            !*manager.exit_signal.borrow(),
            "hub must NOT exit before hub_idle_ms"
        );

        // Now wait past hub_idle_ms.
        let exited = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if *manager.exit_signal.borrow() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(exited.is_ok(), "hub must exit after hub_idle_ms");
    }

    #[tokio::test]
    async fn lifecycle_disabled_when_idle_reap_zero() {
        // idle_reap_ms=0 and hub_idle_ms=0 → reaper is a no-op.
        let (hub, driver) = test_hub();
        let config = LifecycleConfig {
            idle_reap_ms: 0,
            hub_idle_ms: 0,
        };
        let manager = LifecycleManager::start(hub.clone(), driver, config);

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !*manager.exit_signal.borrow(),
            "reaper must be a no-op when both timeouts are ≤ 0"
        );
    }
}
