//! Mac Mini lifecycle contracts: startup classification, Service Management status, and
//! redacted diagnostics. The native registration boundary is intentionally narrow so CI can
//! exercise the state mapping without pretending that an unsigned build is registered.

#![allow(dead_code)]

use serde::Serialize;
use std::sync::{Arc, Mutex};
use url::Url;

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
        LaunchContext::Ordinary
    }
    #[cfg(not(target_os = "macos"))]
    {
        LaunchContext::Unknown
    }
}

pub fn classify_startup(context: LaunchContext) -> StartupMode {
    match context {
        LaunchContext::Login => StartupMode::LoginLaunch,
        LaunchContext::Ordinary => StartupMode::OrdinaryActivation,
        LaunchContext::Unknown => StartupMode::Unknown,
    }
}

/// Events forwarded by the platform startup/delegate adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchEvent {
    DidFinishLaunching,
    DidBecomeActive,
    Reopen,
    TrayOpen,
    SecondInstance,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchViewState {
    Launching,
    InitialActivationIgnored,
    AwaitingUserActivation,
    Revealed,
}

/// Pure launch-context state machine. The first activation generated while AppKit launches is
/// consumed; subsequent activation/reopen/tray events reveal the window.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LaunchContextState {
    pub mode: StartupMode,
    pub view: LaunchViewState,
}

impl LaunchContextState {
    pub fn new(mode: StartupMode) -> Self {
        Self {
            mode,
            view: LaunchViewState::Launching,
        }
    }

    pub fn handle(&mut self, event: LaunchEvent) -> bool {
        match (self.view, event) {
            (LaunchViewState::Launching, LaunchEvent::DidFinishLaunching) => {
                self.view = LaunchViewState::InitialActivationIgnored;
                false
            }
            (LaunchViewState::Launching, LaunchEvent::DidBecomeActive) => {
                self.view = LaunchViewState::InitialActivationIgnored;
                false
            }
            (LaunchViewState::InitialActivationIgnored, LaunchEvent::DidBecomeActive) => {
                self.view = LaunchViewState::AwaitingUserActivation;
                false
            }
            (LaunchViewState::InitialActivationIgnored, LaunchEvent::Reopen)
            | (LaunchViewState::InitialActivationIgnored, LaunchEvent::TrayOpen)
            | (LaunchViewState::InitialActivationIgnored, LaunchEvent::SecondInstance)
            | (LaunchViewState::AwaitingUserActivation, LaunchEvent::DidBecomeActive)
            | (LaunchViewState::AwaitingUserActivation, LaunchEvent::Reopen)
            | (LaunchViewState::AwaitingUserActivation, LaunchEvent::TrayOpen)
            | (LaunchViewState::AwaitingUserActivation, LaunchEvent::SecondInstance)
            | (LaunchViewState::Revealed, LaunchEvent::DidBecomeActive)
            | (LaunchViewState::Revealed, LaunchEvent::Reopen)
            | (LaunchViewState::Revealed, LaunchEvent::TrayOpen)
            | (LaunchViewState::Revealed, LaunchEvent::SecondInstance) => {
                self.view = LaunchViewState::Revealed;
                true
            }
            _ => false,
        }
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

/// A credential-free endpoint suitable for diagnostics. Only origin information is retained.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SafeEndpoint(String);

impl SafeEndpoint {
    pub fn parse(input: &str) -> Option<Self> {
        let url = Url::parse(input).ok()?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return None;
        }
        if url.username() != "" || url.password().is_some() {
            return None;
        }
        let host = url.host_str()?;
        let origin = match url.port() {
            Some(port) => format!("{}://{}:{}", url.scheme(), host_for_display(host), port),
            None => format!("{}://{}", url.scheme(), host_for_display(host)),
        };
        Some(Self(origin))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn host_for_display(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}

fn redact_reason(reason: &str) -> String {
    let lower = reason.to_ascii_lowercase();
    if lower.contains("bearer")
        || lower.contains("authorization")
        || lower.contains("token")
        || lower.contains("password")
        || lower.contains("secret")
    {
        "redacted lifecycle failure".into()
    } else {
        reason.chars().take(160).collect()
    }
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

    pub fn set_endpoint(&self, endpoint: &str) {
        self.0.lock().unwrap().endpoint = SafeEndpoint::parse(endpoint).map(|e| e.0);
    }

    pub fn record_healthy(&self, endpoint: &str, timestamp: impl Into<String>) {
        let mut d = self.0.lock().unwrap();
        d.health = HealthClass::Healthy;
        d.endpoint = SafeEndpoint::parse(endpoint).map(|e| e.0);
        d.last_healthy_at = Some(timestamp.into());
    }

    pub fn record_recovery(
        &self,
        health: HealthClass,
        reason: impl Into<String>,
        timestamp: impl Into<String>,
    ) {
        let mut d = self.0.lock().unwrap();
        d.health = health;
        d.recovery_reason = Some(redact_reason(&reason.into()));
        d.last_restart_at = Some(timestamp.into());
        d.recovery_count = d.recovery_count.saturating_add(1);
    }

    pub fn record_failure(&self, health: HealthClass, reason: impl Into<String>) {
        let mut d = self.0.lock().unwrap();
        d.health = health;
        d.recovery_reason = Some(redact_reason(&reason.into()));
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
    pub fn cancel_relaunch(&self) {
        let mut state = self.state.lock().unwrap();
        let mut owner = self.relaunch_owner.lock().unwrap();
        if *state == LifecycleGateState::Relaunching {
            *state = LifecycleGateState::Running;
            *owner = false;
        }
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

/// Narrow registration boundary. Native Service Management and CI fakes implement this trait;
/// no preference or command-line status is treated as registration evidence.
pub trait ServiceManagementAdapter: Send + Sync {
    fn status(&self) -> LifecycleStatus;
    fn enable(&self) -> Result<LifecycleStatus, String>;
    fn disable(&self) -> Result<LifecycleStatus, String>;
}

#[derive(Clone, Debug)]
pub struct FakeServiceManagementAdapter {
    state: Arc<Mutex<RegistrationState>>,
}

impl FakeServiceManagementAdapter {
    pub fn new(state: RegistrationState) -> Self {
        Self {
            state: Arc::new(Mutex::new(state)),
        }
    }
    fn dto(&self) -> LifecycleStatus {
        let state = *self.state.lock().unwrap();
        LifecycleStatus {
            state,
            enabled: state == RegistrationState::Registered,
            message: format!("fake Service Management state: {state:?}"),
        }
    }
}

impl ServiceManagementAdapter for FakeServiceManagementAdapter {
    fn status(&self) -> LifecycleStatus {
        self.dto()
    }
    fn enable(&self) -> Result<LifecycleStatus, String> {
        *self.state.lock().unwrap() = RegistrationState::Registered;
        Ok(self.dto())
    }
    fn disable(&self) -> Result<LifecycleStatus, String> {
        *self.state.lock().unwrap() = RegistrationState::NotRegistered;
        Ok(self.dto())
    }
}

/// Production adapter boundary. Native operations are available only to the signed packaged
/// application. Development and non-macOS builds fail closed and never infer registration from
/// preferences or command-line tools.
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeServiceManagementAdapter;

#[cfg(not(target_os = "macos"))]
impl ServiceManagementAdapter for NativeServiceManagementAdapter {
    fn status(&self) -> LifecycleStatus {
        LifecycleStatus::unavailable()
    }
    fn enable(&self) -> Result<LifecycleStatus, String> {
        Err("Service Management requires a signed packaged macOS app.".into())
    }
    fn disable(&self) -> Result<LifecycleStatus, String> {
        Err("Service Management requires a signed packaged macOS app.".into())
    }
}

#[cfg(target_os = "macos")]
mod native_service_management {
    use super::*;
    use objc2_core_foundation::{CFRetained, CFURL};
    use objc2_foundation::NSBundle;
    use objc2_security::{SecCSFlags, SecStaticCode};
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    use std::ptr::NonNull;

    /// The only boundary at which Service Management may be called. This deliberately checks
    /// the bundle that contains the running executable, the packaged bundle identifier, and
    /// Apple's code-signing validity result. No preference, environment variable, or smctl
    /// output is accepted as evidence.
    fn signed_packaged_app() -> bool {
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        let Some(app) = exe
            .ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
        else {
            return false;
        };
        if !app.is_dir() || !app.join("Contents/Info.plist").is_file() {
            return false;
        }
        let bundle = NSBundle::mainBundle();
        let Some(identifier) = bundle.bundleIdentifier() else {
            return false;
        };
        if identifier.to_string() != BUNDLE_IDENTIFIER {
            return false;
        }
        let Some(url) = CFURL::from_file_path(app) else {
            return false;
        };
        let mut raw: *const SecStaticCode = std::ptr::null();
        let Some(out) = NonNull::new(&mut raw) else {
            return false;
        };
        // SAFETY: `url` and `out` are valid for this call; Security returns an owned CF object.
        let status = unsafe { SecStaticCode::create_with_path(&url, SecCSFlags(0), out) };
        if status != 0 {
            return false;
        }
        let Some(raw) = NonNull::new(raw as *mut SecStaticCode) else {
            return false;
        };
        // SecStaticCodeCreateWithPath follows Core Foundation's Create rule. CFRetained owns
        // that +1 and calls CFRelease on every return path, including validity-check failure.
        let code: CFRetained<SecStaticCode> = unsafe { CFRetained::from_raw(raw) };
        (unsafe { code.check_validity(SecCSFlags(0), None) }) == 0
    }

    fn status_from_native(status: SMAppServiceStatus) -> LifecycleStatus {
        let (state, message) = if status == SMAppServiceStatus::Enabled {
            (
                RegistrationState::Registered,
                "Registered with macOS Service Management.",
            )
        } else if status == SMAppServiceStatus::NotRegistered {
            (
                RegistrationState::NotRegistered,
                "Not registered with macOS Service Management.",
            )
        } else if status == SMAppServiceStatus::RequiresApproval {
            (
                RegistrationState::RequiresApproval,
                "Registration requires approval in System Settings.",
            )
        } else {
            (
                RegistrationState::Unknown,
                "macOS Service Management returned an unknown status.",
            )
        };
        LifecycleStatus {
            state,
            enabled: state == RegistrationState::Registered,
            message: message.into(),
        }
    }

    fn queried() -> LifecycleStatus {
        if !signed_packaged_app() {
            return LifecycleStatus::unavailable();
        }
        // SAFETY: SMAppService.mainAppService is a macOS ServiceManagement singleton and the
        // returned object is retained by objc2 for the duration of this query.
        let service = unsafe { SMAppService::mainAppService() };
        // SAFETY: status is a side-effect-free query on the retained service object.
        status_from_native(unsafe { service.status() })
    }

    impl ServiceManagementAdapter for NativeServiceManagementAdapter {
        fn status(&self) -> LifecycleStatus {
            queried()
        }
        fn enable(&self) -> Result<LifecycleStatus, String> {
            if !signed_packaged_app() {
                return Err("Service Management requires a signed packaged macOS app.".into());
            }
            let service = unsafe { SMAppService::mainAppService() };
            unsafe { service.registerAndReturnError() }
                .map_err(|error| format!("Service Management registration failed: {error:?}"))?;
            Ok(queried())
        }
        fn disable(&self) -> Result<LifecycleStatus, String> {
            if !signed_packaged_app() {
                return Err("Service Management requires a signed packaged macOS app.".into());
            }
            let service = unsafe { SMAppService::mainAppService() };
            unsafe { service.unregisterAndReturnError() }
                .map_err(|error| format!("Service Management deregistration failed: {error:?}"))?;
            Ok(queried())
        }
    }
}

fn adapter() -> NativeServiceManagementAdapter {
    NativeServiceManagementAdapter
}

pub fn status() -> LifecycleStatus {
    adapter().status()
}
pub fn enable() -> Result<LifecycleStatus, String> {
    adapter().enable()
}
pub fn disable() -> Result<LifecycleStatus, String> {
    adapter().disable()
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
        d.record_healthy("https://[::1]:8787/health?token=secret#x", "now");
        d.record_recovery(
            HealthClass::CrashRestarting,
            "crash; Authorization: Bearer secret",
            "later",
        );
        let json = serde_json::to_string(&d.snapshot()).unwrap();
        assert_eq!(d.snapshot().endpoint.as_deref(), Some("https://[::1]:8787"));
        assert!(!json.contains("Bearer"));
        assert!(!json.contains("secret"));
    }
    #[test]
    fn safe_endpoint_keeps_only_origin_and_rejects_credentials() {
        assert_eq!(
            SafeEndpoint::parse("https://example.test:123/path?q=token#frag")
                .unwrap()
                .as_str(),
            "https://example.test:123"
        );
        assert_eq!(
            SafeEndpoint::parse("http://[::1]:8787/health")
                .unwrap()
                .as_str(),
            "http://[::1]:8787"
        );
        assert!(SafeEndpoint::parse("https://user:pass@example.test").is_none());
        assert!(SafeEndpoint::parse("ftp://example.test/path").is_none());
        assert!(SafeEndpoint::parse("not a url").is_none());
    }
    #[test]
    fn startup_login_is_headless() {
        let mut login = LaunchContextState::new(StartupMode::LoginLaunch);
        assert!(!login.handle(LaunchEvent::DidFinishLaunching));
        assert!(!login.handle(LaunchEvent::DidBecomeActive));
        assert_eq!(login.view, LaunchViewState::AwaitingUserActivation);
        assert!(login.handle(LaunchEvent::Reopen));
        assert_eq!(login.view, LaunchViewState::Revealed);
    }

    #[test]
    fn launch_context_consumes_initial_activation_then_reveals() {
        let mut state = LaunchContextState::new(StartupMode::LoginLaunch);
        assert!(!state.handle(LaunchEvent::DidFinishLaunching));
        // AppKit emits this activation as part of startup; it must not reveal the window.
        assert!(!state.handle(LaunchEvent::DidBecomeActive));
        assert_eq!(state.view, LaunchViewState::AwaitingUserActivation);
        // A later user activation reveals the already-created shell.
        assert!(state.handle(LaunchEvent::DidBecomeActive));
        assert_eq!(state.view, LaunchViewState::Revealed);
    }

    #[test]
    fn launch_context_dock_reopen_reveals_from_headless_start() {
        let mut state = LaunchContextState::new(StartupMode::LoginLaunch);
        assert!(!state.handle(LaunchEvent::DidFinishLaunching));
        assert!(!state.handle(LaunchEvent::DidBecomeActive));
        // This is Tauri's RunEvent::Reopen, backed by applicationShouldHandleReopen.
        assert!(state.handle(LaunchEvent::Reopen));
        assert_eq!(state.view, LaunchViewState::Revealed);
    }
    #[test]
    fn service_management_status_and_operations() {
        for state in [
            RegistrationState::Registered,
            RegistrationState::NotRegistered,
            RegistrationState::RequiresApproval,
            RegistrationState::Unavailable,
        ] {
            let fake = FakeServiceManagementAdapter::new(state);
            assert_eq!(fake.status().state, state);
        }
        let fake = FakeServiceManagementAdapter::new(RegistrationState::NotRegistered);
        assert_eq!(fake.enable().unwrap().state, RegistrationState::Registered);
        assert_eq!(
            fake.disable().unwrap().state,
            RegistrationState::NotRegistered
        );
    }

    #[test]
    fn service_management_fake_supports_enable_disable() {
        let fake = FakeServiceManagementAdapter::new(RegistrationState::RequiresApproval);
        assert_eq!(fake.status().state, RegistrationState::RequiresApproval);
        assert_eq!(fake.enable().unwrap().state, RegistrationState::Registered);
        assert_eq!(
            fake.disable().unwrap().state,
            RegistrationState::NotRegistered
        );
    }
    #[test]
    fn gate_admits_only_one_teardown_and_relaunch() {
        let gate = LifecycleGate::new();
        assert!(gate.try_admit_check());
        assert!(gate.admit_relaunch());
        assert!(!gate.admit_relaunch());
        assert!(gate.begin_teardown());
        gate.complete_teardown();
    }
}
