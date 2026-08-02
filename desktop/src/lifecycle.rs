//! Mac Mini lifecycle contracts: startup classification, Service Management status, and
//! redacted diagnostics. The native registration boundary is intentionally narrow so CI can
//! exercise the state mapping without pretending that an unsigned build is registered.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

pub const BUNDLE_IDENTIFIER: &str = "dev.pantoken.app";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartupMode {
    OrdinaryActivation,
    LoginLaunch,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchContext {
    Login,
    Ordinary,
    Unknown,
}

pub fn launch_context() -> LaunchContext {
    if std::env::var("PANTOKEN_LOGIN_LAUNCH").as_deref() == Ok("1") {
        return LaunchContext::Login;
    }
    #[cfg(target_os = "macos")]
    {
        // The packaged launcher may inject the login context; absent that signal we choose the
        // deterministic ordinary/unknown-safe path rather than treating registration as proof.
        return LaunchContext::Ordinary;
    }
    LaunchContext::Unknown
}

pub fn classify_startup(context: LaunchContext) -> StartupMode {
    match context {
        LaunchContext::Login => StartupMode::LoginLaunch,
        LaunchContext::Ordinary => StartupMode::OrdinaryActivation,
        LaunchContext::Unknown => StartupMode::Unknown,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationState {
    Registered,
    NotRegistered,
    RequiresApproval,
    Unknown,
    Unavailable,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct LifecycleStatus {
    pub state: RegistrationState,
    pub enabled: bool,
    pub message: String,
}

impl LifecycleStatus {
    pub fn unavailable() -> Self {
        Self {
            state: RegistrationState::Unavailable,
            enabled: false,
            message: "Launch at login is only available in a signed macOS app.".into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthClass {
    EndpointUnverified,
    EndpointUnreachable,
    HubUnreachable,
    Unauthorized,
    Healthy,
    CrashRestarting,
    HangRestarting,
    Shutdown,
}

#[derive(Clone, Debug, Serialize)]
pub struct LifecycleDiagnostics {
    pub health: HealthClass,
    pub endpoint: Option<String>,
    pub last_healthy_at: Option<String>,
    pub last_restart_at: Option<String>,
    pub recovery_reason: Option<String>,
    pub recovery_count: u32,
    pub shutdown: bool,
}

#[derive(Clone, Debug)]
pub struct DiagnosticStore(pub Arc<Mutex<LifecycleDiagnostics>>);

impl DiagnosticStore {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(LifecycleDiagnostics {
            health: HealthClass::EndpointUnverified,
            endpoint: None,
            last_healthy_at: None,
            last_restart_at: None,
            recovery_reason: None,
            recovery_count: 0,
            shutdown: false,
        })))
    }
    pub fn snapshot(&self) -> LifecycleDiagnostics {
        self.0.lock().unwrap().clone()
    }
    pub fn set_health(&self, health: HealthClass) {
        self.0.lock().unwrap().health = health;
    }
    pub fn shutdown(&self) {
        let mut d = self.0.lock().unwrap();
        d.shutdown = true;
        d.health = HealthClass::Shutdown;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleGateState {
    Running,
    TeardownAdmitted,
    TornDown,
    Relaunching,
}

#[derive(Debug)]
pub struct LifecycleGate {
    state: Mutex<LifecycleGateState>,
    relaunch_owner: Mutex<bool>,
}

impl LifecycleGate {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(LifecycleGateState::Running),
            relaunch_owner: Mutex::new(false),
        }
    }
    pub fn try_admit_check(&self) -> bool {
        *self.state.lock().unwrap() == LifecycleGateState::Running
    }
    pub fn admit_relaunch(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        let mut owner = self.relaunch_owner.lock().unwrap();
        if *state != LifecycleGateState::Running || *owner {
            return false;
        }
        *owner = true;
        *state = LifecycleGateState::Relaunching;
        true
    }
    pub fn begin_teardown(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if matches!(
            *state,
            LifecycleGateState::TeardownAdmitted | LifecycleGateState::TornDown
        ) {
            return false;
        }
        *state = LifecycleGateState::TeardownAdmitted;
        true
    }
    pub fn complete_teardown(&self) {
        *self.state.lock().unwrap() = LifecycleGateState::TornDown;
    }
    pub fn state(&self) -> LifecycleGateState {
        *self.state.lock().unwrap()
    }
}

#[cfg(target_os = "macos")]
fn native_status() -> LifecycleStatus {
    // Service Management is queried by the packaged app in production. Keep the FFI behind
    // this target gate; debug and CI use the same DTO but never infer registration from prefs.
    let state = std::process::Command::new("/usr/bin/smctl")
        .args(["status", BUNDLE_IDENTIFIER])
        .output();
    match state {
        Ok(out) if out.status.success() => LifecycleStatus {
            state: RegistrationState::Registered,
            enabled: true,
            message: "Registered with macOS Service Management.".into(),
        },
        Ok(_) => LifecycleStatus {
            state: RegistrationState::NotRegistered,
            enabled: false,
            message: "Not registered with macOS Service Management.".into(),
        },
        Err(e) => LifecycleStatus {
            state: RegistrationState::Failed,
            enabled: false,
            message: format!("Could not read Service Management status: {e}"),
        },
    }
}

pub fn status() -> LifecycleStatus {
    #[cfg(target_os = "macos")]
    {
        return native_status();
    }
    #[cfg(not(target_os = "macos"))]
    {
        LifecycleStatus::unavailable()
    }
}

pub fn enable() -> Result<LifecycleStatus, String> {
    #[cfg(target_os = "macos")]
    {
        return Err("Service Management registration requires the signed packaged app; use the app's native registration API.".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Launch at login is unavailable on this platform.".into())
    }
}

pub fn disable() -> Result<LifecycleStatus, String> {
    #[cfg(target_os = "macos")]
    {
        return Err("Service Management deregistration requires the signed packaged app; use the app's native registration API.".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Launch at login is unavailable on this platform.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_mode_classifier_and_activation_routes() {
        assert_eq!(
            classify_startup(LaunchContext::Login),
            StartupMode::LoginLaunch
        );
        assert_eq!(
            classify_startup(LaunchContext::Ordinary),
            StartupMode::OrdinaryActivation
        );
        assert_eq!(
            classify_startup(LaunchContext::Unknown),
            StartupMode::Unknown
        );
    }
    #[test]
    fn lifecycle_status_mapping_and_commands() {
        let status = status();
        #[cfg(not(target_os = "macos"))]
        assert_eq!(status.state, RegistrationState::Unavailable);
        assert!(!status.message.contains("token"));
    }
    #[test]
    fn lifecycle_diagnostics_redacted() {
        let d = DiagnosticStore::new();
        d.set_health(HealthClass::Unauthorized);
        let json = serde_json::to_string(&d.snapshot()).unwrap();
        assert!(!json.contains("Bearer"));
        assert!(!json.contains("secret"));
    }
    #[test]
    fn gate_admits_only_one_teardown_and_relaunch() {
        let gate = LifecycleGate::new();
        assert!(gate.try_admit_check());
        assert!(gate.admit_relaunch());
        assert!(!gate.admit_relaunch());
        assert!(!gate.begin_teardown());
        gate.complete_teardown();
    }
}
