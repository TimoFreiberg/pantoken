//! Pantoken desktop shell (Tauri). Boots a local pantoken server (bundled Rust sidecar
//! binary), gates on /health, then shows the hub-served web client in a chromeless
//! window. See desktop/README.md and docs/ADR-desktop-shell.md.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod bridge;
mod config;
mod dock_attention;
mod docker_target;
mod lifecycle;
mod mouse_nav;
mod proc;
mod provisioning;
mod remote_access;
mod remote_commands;
mod remote_connection;
mod remote_executor;
mod remote_profile;
mod shell;
mod state;
mod supervisor;
mod updater;

use tauri::{AppHandle, Manager, RunEvent};

use crate::config::PantokenConfig;

#[cfg(target_os = "macos")]
mod macos_launch_adapter {
    use super::*;
    use block2::RcBlock;
    use objc2_app_kit::{
        NSApplicationDidBecomeActiveNotification, NSApplicationDidFinishLaunchingNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex, OnceLock};

    static APP: OnceLock<Arc<Mutex<Option<AppHandle>>>> = OnceLock::new();
    static LAUNCH: OnceLock<Arc<Mutex<lifecycle::LaunchContextState>>> = OnceLock::new();

    /// Install AppKit launch notifications before Tauri creates its application delegate. The
    /// observer is deliberately only an event adapter: launch/reopen state remains in the pure
    /// lifecycle state machine and revealing always goes through the shared shell function.
    pub fn install() {
        let app = APP.get_or_init(|| Arc::new(Mutex::new(None))).clone();
        let launch = LAUNCH
            .get_or_init(|| {
                Arc::new(Mutex::new(lifecycle::LaunchContextState::new(
                    lifecycle::classify_startup(lifecycle::launch_context()),
                )))
            })
            .clone();
        let center = NSNotificationCenter::defaultCenter();
        let names = unsafe {
            [
                NSApplicationDidFinishLaunchingNotification,
                NSApplicationDidBecomeActiveNotification,
            ]
        };
        for (index, name) in names.into_iter().enumerate() {
            let app = app.clone();
            let launch = launch.clone();
            let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
                let event = if index == 0 {
                    lifecycle::LaunchEvent::DidFinishLaunching
                } else {
                    lifecycle::LaunchEvent::DidBecomeActive
                };
                if !launch.lock().unwrap().handle(event) {
                    return;
                }
                if let Some(handle) = app.lock().unwrap().clone() {
                    shell::show_main(&handle);
                }
            });
            // SAFETY: the notification names are AppKit constants, the nil object/queue request
            // is valid, and the block has the exact Foundation callback signature.
            unsafe {
                center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block);
            }
            // NSNotificationCenter retains the block observer token until removal. We do not
            // remove it because the process lifetime is the adapter lifetime.
        }
    }

    /// Forward a platform launch event through the shared state machine. Tauri's macOS runtime
    /// invokes this for `NSApplicationDelegate::applicationShouldHandleReopen`, so Dock clicks
    /// use the same reveal path as activation, tray Open, and second-instance launches.
    pub fn handle_event(event: lifecycle::LaunchEvent, app: &AppHandle) {
        let launch = LAUNCH.get_or_init(|| {
            Arc::new(Mutex::new(lifecycle::LaunchContextState::new(
                lifecycle::classify_startup(lifecycle::launch_context()),
            )))
        });
        if launch.lock().unwrap().handle(event) {
            shell::show_main(app);
        }
    }

    pub fn attach_app(app: &AppHandle) {
        let slot = APP.get_or_init(|| Arc::new(Mutex::new(None)));
        *slot.lock().unwrap() = Some(app.clone());
    }
}

#[cfg(not(target_os = "macos"))]
mod macos_launch_adapter {
    pub fn install() {}
    pub fn attach_app(_: &tauri::AppHandle) {}
}
use std::sync::OnceLock;

use crate::state::AppState;
use crate::supervisor::{Supervisor, SupervisorEvent};

/// Process start, for the launch-to-healthy stderr line (agent-legible perf probe).
static LAUNCHED: OnceLock<std::time::Instant> = OnceLock::new();

fn main() {
    // Block SIGTERM/SIGINT process-wide BEFORE any thread exists (threads inherit the
    // mask); a dedicated thread sigwait()s them into a normal app exit. Without this a
    // logout / launchd stop / plain `kill` tears the shell down WITHOUT RunEvent::Exit,
    // orphaning the hub it supervises.
    let term_signals = block_term_signals();
    LAUNCHED.set(std::time::Instant::now()).ok();

    // Install the platform launch adapter before Tauri setup so login launches and the first
    // AppKit activation are observed without relying on registration status or environment state.
    macos_launch_adapter::install();

    tauri::Builder::default()
        // Must be first: a second launch hands off to us and exits before other plugins run.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            #[cfg(target_os = "macos")]
            macos_launch_adapter::handle_event(lifecycle::LaunchEvent::SecondInstance, app);
            #[cfg(not(target_os = "macos"))]
            shell::show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            remote_commands::list_remote_profiles,
            remote_commands::add_remote_profile,
            remote_commands::update_remote_profile,
            remote_commands::delete_remote_profile,
            remote_commands::ensure_remote_host,
            remote_commands::host_state,
            remote_commands::list_hosts,
            remote_commands::disconnect_host,
            remote_commands::acknowledge_risk,
            remote_commands::cancel_connection,
            remote_commands::resume_connection,
            remote_commands::test_ssh_and_list_containers,
            remote_commands::inspect_container,
            dock_attention::request_dock_attention,
            dock_attention::set_dock_badge,
            lifecycle_status,
            enable_launch_at_login,
            disable_launch_at_login,
            lifecycle_diagnostics,
        ])
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let handle = app.handle().clone();
            macos_launch_adapter::attach_app(&handle);
            let (config, fatal) = match PantokenConfig::resolve_launch(&resource_dir) {
                Ok(c) => (c, None),
                // A resolve failure still wants the window + tray up so the fatal
                // dialog has an app to hang off — park a harmless fallback config
                // (nothing gets started; the dialog exits on dismiss).
                Err(message) => (PantokenConfig::fallback(8787), Some(message)),
            };
            app.manage(AppState::new(config));

            // Start headlessly for every launch. Login launches must not reveal a window, and
            // ordinary launches wait for AppKit activation, tray Open, or second-instance focus
            // to create/reveal it through the same shell path.
            shell::create_tray(&handle)?;
            #[cfg(not(target_os = "macos"))]
            shell::create_main_window(&handle)?;

            // Native macOS mouse thumb-button (back/forward) → webview nav.
            // No-op on non-macOS; the DOM onauxclick handler is the browser fallback.
            mouse_nav::install(app.handle().clone());

            if let Some(message) = fatal {
                shell::present_fatal(&handle, &message);
                return Ok(());
            }

            let state = app.state::<AppState>();
            let config = state.config.clone();

            std::fs::create_dir_all(&config.data_dir)?;

            let supervisor = Supervisor::start(config.clone(), {
                let app = app.handle().clone();
                move |event| on_supervisor_event(&app, event)
            });
            state.supervisor.lock().unwrap().replace(supervisor);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pantoken")
        .run_with_signals(term_signals);
}

trait RunWithSignals {
    fn run_with_signals(self, signals: libc::sigset_t);
}

impl RunWithSignals for tauri::App {
    fn run_with_signals(self, signals: libc::sigset_t) {
        let handle = self.handle().clone();
        std::thread::spawn(move || {
            let mut sig: libc::c_int = 0;
            unsafe { libc::sigwait(&signals, &mut sig) };
            eprintln!("pantoken: received signal {sig}, shutting down");
            // Routes into RunEvent::Exit below — the same teardown as a normal quit.
            handle.exit(0);
        });
        self.run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                // Tauri forwards NSApplicationDelegate::applicationShouldHandleReopen here.
                // Keep Dock reopen on the same state-machine/reveal path as activation.
                macos_launch_adapter::handle_event(lifecycle::LaunchEvent::Reopen, app);
            }
            match event {
                // AppKit Cmd-Q/application termination arrives here before Tauri emits
                // Exit. Admit it through the same request path as tray Quit and signals;
                // the resulting Exit event performs the idempotent teardown exactly once.
                RunEvent::ExitRequested { api, code, .. } => {
                    if code.is_none() {
                        api.prevent_exit();
                        shell::request_quit(app);
                    }
                }
                RunEvent::Exit => {
                    app.state::<AppState>().teardown();
                }
                _ => {}
            }
        });
    }
}

/// Block SIGTERM/SIGINT for the whole process (called before any thread spawns, so every
/// thread inherits the mask) and return the set for the sigwait thread.
fn block_term_signals() -> libc::sigset_t {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    }
}

#[tauri::command]
fn lifecycle_status() -> lifecycle::LifecycleStatus {
    lifecycle::status()
}

#[tauri::command]
fn enable_launch_at_login() -> Result<lifecycle::LifecycleStatus, String> {
    lifecycle::enable()
}

#[tauri::command]
fn disable_launch_at_login() -> Result<lifecycle::LifecycleStatus, String> {
    lifecycle::disable()
}

#[tauri::command]
fn lifecycle_diagnostics(state: tauri::State<'_, AppState>) -> lifecycle::LifecycleDiagnostics {
    state.diagnostics.snapshot()
}

fn recovery_message(outcome: crate::supervisor::ProbeOutcome) -> &'static str {
    match outcome {
        crate::supervisor::ProbeOutcome::Unauthorized => {
            "Pantoken hub authorization failed; retrying…"
        }
        crate::supervisor::ProbeOutcome::Unreachable => "Pantoken hub is unavailable; retrying…",
        crate::supervisor::ProbeOutcome::Malformed => {
            "Pantoken hub returned an invalid health response; retrying…"
        }
        crate::supervisor::ProbeOutcome::WrongTarget => {
            "Pantoken endpoint changed unexpectedly; retrying…"
        }
        crate::supervisor::ProbeOutcome::EndpointUnverified => {
            "Pantoken endpoint could not be verified; retrying…"
        }
        crate::supervisor::ProbeOutcome::Healthy => "Pantoken hub is healthy.",
    }
}

fn recovery_message_for_reason(reason: crate::supervisor::RecoveryReason) -> &'static str {
    match reason {
        crate::supervisor::RecoveryReason::Hang => "Pantoken hub stopped responding; restarting…",
        crate::supervisor::RecoveryReason::Crash => "Pantoken hub stopped; restarting…",
        _ => "Pantoken hub is recovering; restarting…",
    }
}

fn on_supervisor_event(app: &AppHandle, event: SupervisorEvent) {
    let state = app.state::<AppState>();
    let endpoint = state.config.app_url();
    let timestamp = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis().to_string())
            .unwrap_or_else(|_| "0".into())
    };
    state.diagnostics.set_endpoint(&endpoint);
    match event {
        SupervisorEvent::Healthy { first_time } => {
            state.diagnostics.record_healthy(&endpoint, timestamp());
            shell::clear_recovery_notice(app);
            if first_time {
                if let Some(t0) = LAUNCHED.get() {
                    eprintln!(
                        "pantoken: hub healthy {}ms after launch",
                        t0.elapsed().as_millis()
                    );
                }
            }
            if state.config.mode == crate::config::LaunchMode::Remote {
                // The current Tauri shell has no request-header interception seam;
                // never navigate the webview to authenticated static content.
                state.overlay.hide(app);
                shell::present_fatal(
                    app,
                    "Remote backend is healthy, but authenticated desktop document delivery is deferred to issue #148/03.",
                );
                return;
            }
            state.overlay.navigated();
            shell::navigate_main(app, &state.config.app_url());
            if first_time {
                // One artifact = shell + hub + client, so the shell's own update loop
                // owns updates — it drives the sidebar card over /update/state and
                // applies via the Tauri updater.
                updater::spawn_periodic(app.clone());
            }
        }
        SupervisorEvent::ProbeFailed { outcome } => {
            let health = match outcome {
                crate::supervisor::ProbeOutcome::Unauthorized => {
                    crate::lifecycle::HealthClass::Unauthorized
                }
                crate::supervisor::ProbeOutcome::Unreachable => {
                    crate::lifecycle::HealthClass::EndpointUnreachable
                }
                crate::supervisor::ProbeOutcome::Malformed
                | crate::supervisor::ProbeOutcome::WrongTarget
                | crate::supervisor::ProbeOutcome::EndpointUnverified => {
                    crate::lifecycle::HealthClass::EndpointUnverified
                }
                crate::supervisor::ProbeOutcome::Healthy => crate::lifecycle::HealthClass::Healthy,
            };
            state.diagnostics.set_health(health);
            state
                .diagnostics
                .record_failure(health, format!("health probe: {outcome:?}"));
            shell::show_recovery_notice(app, recovery_message(outcome));
        }
        SupervisorEvent::Restarting { reason } => {
            let health = match reason {
                crate::supervisor::RecoveryReason::Hang => {
                    crate::lifecycle::HealthClass::HangRestarting
                }
                _ => crate::lifecycle::HealthClass::CrashRestarting,
            };
            state
                .diagnostics
                .record_recovery(health, format!("{reason:?}"), timestamp());
            shell::show_recovery_notice(app, recovery_message_for_reason(reason));
        }
        SupervisorEvent::Unrecoverable(message) => {
            state.diagnostics.record_failure(
                crate::lifecycle::HealthClass::HubUnreachable,
                "unrecoverable supervisor state",
            );
            state.overlay.hide(app);
            shell::present_fatal(app, &message);
        }
    }
}
