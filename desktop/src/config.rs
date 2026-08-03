//! Resolved launch configuration — the Rust port of the Swift shell's `Config.swift`.
//!
//! The hub is a compiled Rust sidecar binary inside the bundle
//! (Contents/MacOS/pantoken-server) serving the bundled client (Resources/client-dist).
//! Fully self-contained — the Tauri updater updates shell + hub + client atomically
//! (updater.rs owns the loop).
//!
//! `PANTOKEN_HUB_MODE=bundled` overrides the default detection; a bundled resolution
//! with a missing sidecar/client is a FATAL config error, never a silent fallback.

use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::{Path, PathBuf};

pub const DEFAULT_REMOTE_PORT: u16 = 8787;
pub const KEYCHAIN_SERVICE: &str = "dev.pantoken.app.remote-access";
pub const KEYCHAIN_ACCOUNT: &str = "bearer-token";
const REMOTE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchMode {
    Local,
    Remote,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteConfig {
    pub enabled: bool,
    pub hub_port: u16,
    pub origin: Option<String>,
    pub endpoint_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PersistedRemoteConfig {
    #[serde(rename = "schema_version")]
    schema: u32,
    enabled: bool,
    hub_port: u16,
    origin: Option<String>,
    endpoint_metadata: Option<serde_json::Value>,
    keychain_token: KeychainTokenReference,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct KeychainTokenReference {
    service: String,
    account: String,
    state: String,
}

pub trait TokenStore {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, token: &str) -> Result<(), String>;
}

#[cfg(target_os = "macos")]
fn default_token_store() -> Box<dyn TokenStore> {
    Box::new(MacOsKeychain)
}

#[cfg(test)]
#[derive(Default)]
struct FakeTokenStore {
    token: std::sync::Mutex<Option<String>>,
    fail_reads: std::sync::atomic::AtomicBool,
    fail_writes: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl FakeTokenStore {
    fn new() -> Self {
        Self::default()
    }

    fn delete(&self) -> Result<(), String> {
        *self.token.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
impl TokenStore for FakeTokenStore {
    fn read(&self) -> Result<Option<String>, String> {
        if self.fail_reads.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("keychain read failed".into());
        }
        Ok(self.token.lock().unwrap().clone())
    }
    fn write(&self, token: &str) -> Result<(), String> {
        if self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("keychain write failed".into());
        }
        *self.token.lock().unwrap() = Some(token.to_owned());
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub struct MacOsKeychain;
#[cfg(target_os = "macos")]
impl TokenStore for MacOsKeychain {
    fn read(&self) -> Result<Option<String>, String> {
        let out = std::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                KEYCHAIN_ACCOUNT,
                "-w",
            ])
            .output()
            .map_err(|e| format!("keychain read failed: {e}"))?;
        if !out.status.success() {
            return Ok(None);
        }
        String::from_utf8(out.stdout)
            .map(|s| Some(s.trim_end().to_owned()))
            .map_err(|_| "keychain returned invalid UTF-8".into())
    }
    fn write(&self, token: &str) -> Result<(), String> {
        let status = std::process::Command::new("security")
            .args([
                "add-generic-password",
                "-U",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                KEYCHAIN_ACCOUNT,
                "-w",
                token,
            ])
            .status()
            .map_err(|e| format!("keychain write failed: {e}"))?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "keychain write failed".into())
    }
}

pub struct PantokenConfig {
    /// The hub binary path and client dist dir.
    pub hub_bin: PathBuf,
    pub client_dist: PathBuf,
    /// Server state (VAPID key, archive index, pantoken.pid). Same dir as the Swift shell so
    /// the two apps share one identity — but never run both at once (the pidlock refuses).
    /// Override: PANTOKEN_APP_DATA_DIR (a name the server never exports into spawned shells,
    /// unlike PANTOKEN_DATA_DIR — so a test launch can't be hijacked by an inherited value).
    pub data_dir: PathBuf,
    /// Port passed to the server. Local mode chooses a free port; remote mode persists it.
    pub server_port: u16,
    pub mode: LaunchMode,
    /// Resolved bearer token for remote mode; never persisted in the JSON config.
    pub token: Option<String>,
    /// PATH handed to the spawned server so it (git/rg/shell) resolves its tools.
    /// Mirrors the deploy plists' PATH.
    pub augmented_path: String,
}

impl PantokenConfig {
    /// Resolve the startup mode before selecting a port. Local mode preserves the
    /// historical random-port behavior; enabled remote mode is deterministic and
    /// fails closed if its persisted configuration or Keychain item is invalid.
    pub fn resolve_launch(resource_dir: &Path) -> Result<Self, String> {
        let data_dir = std::env::var("PANTOKEN_APP_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home_dir().join("Library/Application Support/Pantoken"));
        #[cfg(not(target_os = "macos"))]
        let resolution = resolve_hub_mode(resource_dir)?;
        #[cfg(target_os = "macos")]
        {
            let store = default_token_store();
            Self::resolve_launch_with_token_store(resource_dir, &data_dir, store.as_ref())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let remote = Self::load_remote(&data_dir.join("remote-access.json"))?;
            if remote.enabled {
                return Err("remote mode requires the macOS Keychain adapter".into());
            }
            Ok(Self::build(
                free_port().map_err(|e| format!("couldn't acquire local loopback port: {e}"))?,
                resolution,
            ))
        }
    }

    #[cfg(any(test, target_os = "macos"))]
    pub fn resolve_launch_with_token_store(
        resource_dir: &Path,
        data_dir: &Path,
        token_store: &dyn TokenStore,
    ) -> Result<Self, String> {
        let resolution = resolve_hub_mode(resource_dir)?;
        let remote = Self::load_remote(&data_dir.join("remote-access.json"))?;
        if !remote.enabled {
            return Ok(Self::build(
                free_port().map_err(|e| format!("couldn't acquire local loopback port: {e}"))?,
                resolution,
            ));
        }
        let token = Self::ensure_token(token_store)?;
        Self::remote(remote.hub_port, resolution, token)
    }

    /// Config for the fatal-error path when resolve() failed: dummy paths that
    /// nothing will ever spawn from — it exists so the window/tray (which read config
    /// for display) can come up under the fatal dialog.
    pub fn fallback(server_port: u16) -> Self {
        Self::fallback_with_app_data_dir(server_port, None)
    }

    /// Build a fallback config with an isolated data directory.
    ///
    /// Production callers use [`Self::fallback`], whose data directory follows the
    /// process configuration. Tests can provide the directory explicitly instead
    /// of mutating the process environment.
    pub fn fallback_with_app_data_dir(server_port: u16, data_dir: Option<&Path>) -> Self {
        Self::build_with_data_dir(
            server_port,
            HubResolution {
                hub_bin: PathBuf::new(),
                client_dist: PathBuf::new(),
            },
            data_dir,
        )
    }

    fn build(server_port: u16, resolution: HubResolution) -> Self {
        Self::build_with_data_dir(server_port, resolution, None)
    }

    fn build_with_data_dir(
        server_port: u16,
        resolution: HubResolution,
        explicit_data_dir: Option<&Path>,
    ) -> Self {
        let home = home_dir();
        let data_dir = explicit_data_dir
            .map(Path::to_path_buf)
            .or_else(|| {
                std::env::var("PANTOKEN_APP_DATA_DIR")
                    .ok()
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| home.join("Library/Application Support/Pantoken"));

        let path_dirs = [
            home.join(".bun/bin"),
            home.join(".local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ];
        let augmented_path = path_dirs
            .iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(":");

        Self {
            hub_bin: resolution.hub_bin,
            client_dist: resolution.client_dist,
            data_dir,
            server_port,
            mode: LaunchMode::Local,
            token: None,
            augmented_path,
        }
    }

    pub(crate) fn remote(
        server_port: u16,
        resolution: HubResolution,
        token: String,
    ) -> Result<Self, String> {
        Self::validate_remote_port(server_port)?;
        if token.is_empty() {
            return Err("remote bearer token must not be empty".into());
        }
        let mut config = Self::build(server_port, resolution);
        config.mode = LaunchMode::Remote;
        config.token = Some(token);
        Ok(config)
    }

    pub fn app_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.server_port)
    }

    /// Path to the persisted remote-host profiles JSON file
    /// (`{data_dir}/remote-profiles.json`). The same data dir the app uses for
    /// its hub pidlock / settings, so profiles travel with the app identity.
    pub fn remote_profiles_path(&self) -> std::path::PathBuf {
        self.data_dir.join("remote-profiles.json")
    }

    /// Environment for the spawned server: force a usable PATH, loopback host, port,
    /// data directory, and client distribution. The bearer token is included only for
    /// a remote config; local mode intentionally supplies no token.
    ///
    /// PANTOKEN_CLIENT_DIST points the Rust server at the bundled client (it can't
    /// resolve the client relative to its own source — it has none).
    pub fn server_env(&self) -> Vec<(String, String)> {
        vec![
            ("PATH".into(), self.augmented_path.clone()),
            ("PANTOKEN_HOST".into(), "127.0.0.1".into()),
            ("PANTOKEN_PORT".into(), self.server_port.to_string()),
            (
                "PANTOKEN_DATA_DIR".into(),
                self.data_dir.to_string_lossy().into_owned(),
            ),
            (
                "PANTOKEN_CLIENT_DIST".into(),
                self.client_dist.to_string_lossy().into_owned(),
            ),
        ]
        .into_iter()
        .chain(
            self.token
                .as_ref()
                .map(|token| ("PANTOKEN_TOKEN".into(), token.clone())),
        )
        .collect()
    }

    pub fn validate_remote_port(port: u16) -> Result<u16, String> {
        if (1024..=65535).contains(&port) {
            Ok(port)
        } else {
            Err(format!(
                "remote hub port {port} must be between 1024 and 65535"
            ))
        }
    }

    pub fn load_remote(path: &Path) -> Result<RemoteConfig, String> {
        if !path.exists() {
            return Ok(RemoteConfig {
                enabled: false,
                hub_port: DEFAULT_REMOTE_PORT,
                origin: None,
                endpoint_metadata: None,
            });
        }
        let bytes = std::fs::read(path)
            .map_err(|e| format!("could not read remote access configuration: {e}"))?;
        let stored: PersistedRemoteConfig = serde_json::from_slice(&bytes)
            .map_err(|e| format!("invalid remote access configuration: {e}"))?;
        if stored.schema != REMOTE_SCHEMA_VERSION {
            return Err(format!(
                "unsupported remote access configuration schema {}",
                stored.schema
            ));
        }
        Self::validate_remote_port(stored.hub_port)?;
        if stored.keychain_token.service != KEYCHAIN_SERVICE
            || stored.keychain_token.account != KEYCHAIN_ACCOUNT
        {
            return Err("invalid remote access keychain reference".into());
        }
        if let Some(origin) = &stored.origin {
            validate_origin(origin)?;
        }
        Ok(RemoteConfig {
            enabled: stored.enabled,
            hub_port: stored.hub_port,
            origin: stored.origin,
            endpoint_metadata: stored.endpoint_metadata,
        })
    }

    #[cfg(test)]
    pub fn save_remote(path: &Path, remote: &RemoteConfig) -> Result<(), String> {
        Self::validate_remote_port(remote.hub_port)?;
        if let Some(origin) = &remote.origin {
            validate_origin(origin)?;
        }
        let stored = PersistedRemoteConfig {
            schema: REMOTE_SCHEMA_VERSION,
            enabled: remote.enabled,
            hub_port: remote.hub_port,
            origin: remote.origin.clone(),
            endpoint_metadata: remote.endpoint_metadata.clone(),
            keychain_token: KeychainTokenReference {
                service: KEYCHAIN_SERVICE.into(),
                account: KEYCHAIN_ACCOUNT.into(),
                state: if remote.enabled { "active" } else { "missing" }.into(),
            },
        };
        let data = serde_json::to_vec_pretty(&stored)
            .map_err(|e| format!("could not encode remote access configuration: {e}"))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, data)
            .map_err(|e| format!("could not write remote access configuration: {e}"))?;
        std::fs::rename(&tmp, path)
            .map_err(|e| format!("could not commit remote access configuration: {e}"))
    }

    pub fn ensure_token(store: &dyn TokenStore) -> Result<String, String> {
        if let Some(token) = store.read()? {
            if !token.is_empty() {
                return Ok(token);
            }
        }
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        store.write(&token)?;
        Ok(token)
    }
}

fn validate_origin(origin: &str) -> Result<(), String> {
    let parsed =
        url::Url::parse(origin).map_err(|_| "origin must be a valid HTTPS URL".to_owned())?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "" && parsed.path() != "/"
    {
        return Err(
            "origin must be an HTTPS host URL without credentials, path, query, or fragment".into(),
        );
    }
    Ok(())
}

#[allow(dead_code)]
pub fn canonical_origin(origin: &str) -> Result<String, String> {
    validate_origin(origin)?;
    let mut parsed = url::Url::parse(origin).map_err(|_| "origin must be a valid HTTPS URL")?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    parsed
        .set_host(Some(&host))
        .map_err(|_| "origin host is invalid")?;
    parsed.set_path("/");
    Ok(parsed.to_string())
}

pub(crate) struct HubResolution {
    hub_bin: PathBuf,
    client_dist: PathBuf,
}

/// The sidecar lands next to the main exe: Contents/MacOS/pantoken-server in the bundle,
/// target/<profile>/pantoken-server when tauri-build stages it for a dev/debug run.
fn resolve_hub_mode(resource_dir: &Path) -> Result<HubResolution, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;

    // PANTOKEN_HUB_MODE=bundled forces the bundled path (useful for testing a debug
    // binary as if it were packaged). Any other value is rejected.
    match std::env::var("PANTOKEN_HUB_MODE").as_deref() {
        Ok("bundled") => {}
        Ok(other) => {
            return Err(format!(
                "PANTOKEN_HUB_MODE must be 'bundled' (got '{other}'); clone mode was removed when the TS server was deleted"
            ));
        }
        Err(_) => {
            // Auto-detect: are we inside a .app bundle?
            if !(exe.components().any(|c| c.as_os_str() == "Contents")
                && exe.parent().is_some_and(|p| p.ends_with("MacOS")))
            {
                // Dev mode: look for the binary tauri-build staged next to the
                // dev binary (target/<profile>/pantoken-server), or fall back to the
                // repo's cargo build output.
                let dev_bin = exe
                    .parent()
                    .ok_or("exe has no parent dir")?
                    .join("pantoken-server");
                if dev_bin.is_file() {
                    let client_dist = resource_dir.join("client-dist");
                    if !client_dist.join("index.html").is_file() {
                        // In dev the client may not be built yet — use the repo's client/dist.
                        return Ok(HubResolution {
                            hub_bin: dev_bin,
                            client_dist: std::env::current_dir()
                                .unwrap_or_default()
                                .join("client/dist"),
                        });
                    }
                    return Ok(HubResolution {
                        hub_bin: dev_bin,
                        client_dist,
                    });
                }
                // Not staged — use the cargo release build if it exists, else error.
                return Ok(HubResolution {
                    hub_bin: dev_bin,
                    client_dist: resource_dir.join("client-dist"),
                });
            }
        }
    }

    let hub_bin = exe
        .parent()
        .ok_or("exe has no parent dir")?
        .join("pantoken-server");
    let client_dist = resource_dir.join("client-dist");
    // Loud precondition checks: a packaged app missing its payload is a broken build —
    // crash with specifics rather than limping along.
    if !hub_bin.is_file() {
        return Err(format!(
            "bundled hub binary missing at {} — broken bundle (was the app built with \
             `bun run build` in desktop, which compiles the hub sidecar?)",
            hub_bin.display()
        ));
    }
    if !client_dist.join("index.html").is_file() {
        return Err(format!(
            "bundled client missing at {} — broken bundle (tauri.conf.json maps \
             ../client/dist as the client-dist resource; was the client built?)",
            client_dist.display()
        ));
    }
    Ok(HubResolution {
        hub_bin,
        client_dist,
    })
}

pub fn free_port() -> std::io::Result<u16> {
    // Bind :0, read the assigned port, drop the listener. Same small race the Swift
    // PortFinder accepted: the port could be taken between here and the server's bind —
    // the supervisor's health gate + crash-loop breaker surface that loudly if it ever
    // happens.
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME not set"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_env_always_includes_client_dist() {
        let cfg = PantokenConfig::build(
            12345,
            HubResolution {
                hub_bin: PathBuf::from("/tmp/pantoken-server"),
                client_dist: PathBuf::from("/tmp/client-dist"),
            },
        );
        let env = cfg.server_env();
        let has_client_dist = env
            .iter()
            .any(|(k, v)| k == "PANTOKEN_CLIENT_DIST" && v == "/tmp/client-dist");
        assert!(has_client_dist, "PANTOKEN_CLIENT_DIST must always be set");
    }

    #[test]
    fn server_env_has_port_and_host() {
        let cfg = PantokenConfig::build(
            9999,
            HubResolution {
                hub_bin: PathBuf::new(),
                client_dist: PathBuf::new(),
            },
        );
        let env = cfg.server_env();
        assert!(env.iter().any(|(k, v)| k == "PANTOKEN_PORT" && v == "9999"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "PANTOKEN_HOST" && v == "127.0.0.1"));
        assert!(!env.iter().any(|(k, _)| k == "PANTOKEN_TOKEN"));
    }

    #[test]
    fn remote_mode_env_includes_token_and_loopback() {
        let cfg = PantokenConfig::remote(
            8787,
            HubResolution {
                hub_bin: PathBuf::new(),
                client_dist: PathBuf::new(),
            },
            "test-token".into(),
        )
        .unwrap();
        assert_eq!(cfg.mode, LaunchMode::Remote);
        assert!(cfg
            .server_env()
            .iter()
            .any(|(k, v)| k == "PANTOKEN_TOKEN" && v == "test-token"));
        assert!(cfg
            .server_env()
            .iter()
            .any(|(k, v)| k == "PANTOKEN_HOST" && v == "127.0.0.1"));
    }

    #[test]
    fn remote_access_round_trip_and_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote-access.json");
        let missing = PantokenConfig::load_remote(&path).unwrap();
        assert_eq!(missing.hub_port, DEFAULT_REMOTE_PORT);
        assert!(!missing.enabled);
        let saved = RemoteConfig {
            enabled: true,
            hub_port: 9000,
            origin: Some("https://example.test".into()),
            endpoint_metadata: Some(serde_json::json!({"kind":"loopback"})),
        };
        PantokenConfig::save_remote(&path, &saved).unwrap();
        assert_eq!(PantokenConfig::load_remote(&path).unwrap(), saved);
    }

    #[test]
    fn invalid_remote_port_and_origin_are_rejected() {
        assert!(PantokenConfig::validate_remote_port(1023).is_err());
        assert!(PantokenConfig::validate_remote_port(0).is_err());
        let dir = tempfile::tempdir().unwrap();
        let result = PantokenConfig::save_remote(
            &dir.path().join("remote-access.json"),
            &RemoteConfig {
                enabled: true,
                hub_port: 8787,
                origin: Some("http://example.test".into()),
                endpoint_metadata: None,
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn token_persistence_and_rotation() {
        let store = FakeTokenStore::new();
        let first = PantokenConfig::ensure_token(&store).unwrap();
        assert!(!first.is_empty());
        assert_eq!(PantokenConfig::ensure_token(&store).unwrap(), first);
        store.delete().unwrap();
        let second = PantokenConfig::ensure_token(&store).unwrap();
        assert_ne!(first, second);
        store
            .fail_reads
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(PantokenConfig::ensure_token(&store).is_err());
    }
}
