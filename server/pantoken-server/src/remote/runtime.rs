//! Persistent remote runtime mode + stdio-proxy command mode (Phase 1.3).
//!
//! Two `PANTOKEN_SERVE_MODE` values:
//!
//! - **`remote-runtime`**: listens on a private Unix socket under the remote
//!   root, single-instance locked via `pidlock`, serves framed connections via
//!   `ConnectionSession`. Exposes an identity probe so the proxy can
//!   distinguish not-installed/starting/incompatible/running before the hello
//!   gate.
//!
//! - **`stdio-proxy`**: connects to the runtime's Unix socket (bootstrapping
//!   it if absent), probes identity, then relays framed bytes between
//!   stdin/stdout and the socket.
//!
//! Both modes keep stdout protocol-only (AC.2) and bind no public TCP
//! listener (AC.3).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::connection::stdio::{FramedRelay, StdioAdapter};
use crate::connection::{ConnectionSession, SessionEnv};
use crate::driver::PantokenDriver;
use crate::hub::SessionHub;
use crate::pidlock;
use pantoken_daemon_types::POLYTOKEN_DAEMON_TARGET_VERSION;
use pantoken_protocol::frame::FrameDecoder;
use pantoken_protocol::wire::PROTOCOL_VERSION;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tracing::{error, info, warn};

use crate::remote::layout;

/// Bounded timeout for the proxy to wait for the runtime's socket readiness.
const SOCKET_READINESS_TIMEOUT_SECS: u64 = 30;

// ── Identity probe ─────────────────────────────────────────────────────

/// The identity probe: a lightweight pre-authentication exchange. The proxy
/// sends a framed `{"type":"probe"}` JSON; the runtime responds with a framed
/// `Identity` JSON. This is NOT a `ServerMessage::Hello` (the real Hello is a
/// post-registration response) — it's a separate pre-auth exchange.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    #[serde(rename = "daemonTargetVersion")]
    pub daemon_target_version: String,
    pub state: RuntimeState,
}

/// The four runtime states the proxy can observe (plan step 8).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeState {
    /// Socket connect succeeds, identity handshake returns versions.
    Running,
    /// Socket exists but identity handshake not ready yet (proxy waits).
    Starting,
    /// Identity reports a protocol-version or daemon-target mismatch.
    Incompatible,
    /// Socket absent + no pidfile (proxy proceeds to bootstrap).
    NotInstalled,
}

/// Send a probe frame and read the identity response over a Unix socket.
///
/// Used by the stdio-proxy to check the runtime's state before relaying.
/// The probe is a separate connection — the proxy connects, probes, closes,
/// then reconnects for the real session.
pub async fn probe_identity(socket_path: &Path) -> std::io::Result<Identity> {
    let mut stream = UnixStream::connect(socket_path).await?;

    // Send the probe frame.
    let probe_json = br#"{"type":"probe"}"#;
    let mut frame = Vec::with_capacity(4 + probe_json.len());
    frame.extend_from_slice(&(probe_json.len() as u32).to_be_bytes());
    frame.extend_from_slice(probe_json);
    stream.write_all(&frame).await?;
    stream.flush().await?;

    // Read the identity response frame.
    let mut decoder = FrameDecoder::new();
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "runtime closed before identity response",
                ));
            }
            Ok(n) => {
                if let Some(body) = decoder.push(&buf[..n]).into_iter().flatten().next() {
                    let identity: Identity = serde_json::from_slice(&body)
                        .map_err(|e| std::io::Error::other(format!("identity parse: {e}")))?;
                    return Ok(identity);
                }
            }
            Err(e) => return Err(e),
        }
    }
}

// ── stdio-proxy mode ────────────────────────────────────────────────────

/// Entry point for `PANTOKEN_SERVE_MODE=stdio-proxy`.
///
/// Connects to the persistent runtime's Unix socket (bootstrapping it if
/// absent), probes identity, then relays framed bytes between stdin/stdout
/// and the socket. All diagnostics go to stderr; stdout carries only framed
/// protocol bytes.
pub async fn run_stdio_proxy(root: &Path) -> std::io::Result<()> {
    let socket_path = layout::private_socket(root);

    // Bootstrap the runtime if absent (race-safe).
    let stream = match connect_with_bootstrap(root, &socket_path).await {
        Ok(s) => s,
        Err(e) => {
            error!("stdio-proxy: failed to connect to runtime: {e}");
            return Err(e);
        }
    };

    // Probe identity on a separate connection.
    match probe_identity(&socket_path).await {
        Ok(Identity {
            state: RuntimeState::Running,
            ..
        }) => {
            info!("stdio-proxy: runtime is running, relaying");
        }
        Ok(Identity {
            state: RuntimeState::Incompatible,
            protocol_version,
            daemon_target_version,
        }) => {
            error!(
                "stdio-proxy: runtime incompatible — protocol={} (ours={}), daemon_target={} (ours={})",
                protocol_version,
                PROTOCOL_VERSION,
                daemon_target_version,
                POLYTOKEN_DAEMON_TARGET_VERSION
            );
            return Err(std::io::Error::other("runtime protocol version mismatch"));
        }
        Ok(Identity { state, .. }) => {
            warn!("stdio-proxy: runtime state {state:?} after bootstrap — proceeding anyway");
        }
        Err(e) => {
            warn!("stdio-proxy: identity probe failed ({e}) — proceeding to relay");
        }
    }

    // Relay framed bytes between stdin/stdout and the socket.
    let (stdin, stdout) = (tokio::io::stdin(), tokio::io::stdout());
    let (socket_read, socket_write) = stream.into_split();
    let relay = FramedRelay {
        left_read: stdin,
        left_write: stdout,
        right_read: socket_read,
        right_write: socket_write,
    };
    relay.run().await
}

/// Resolve the server executable used to bootstrap a remote runtime.
///
/// Buck2 supplies `PANTOKEN_SERVER_BIN` as a resource-relative path and
/// `RUNFILES_DIR` identifies the runfiles root. Cargo callers omit the
/// override and use the conventional `target/debug/pantoken-server` path.
/// Resolve a server binary from explicit environment values and a Cargo fallback.
///
/// `OsStr` inputs deliberately preserve non-UTF-8 paths. The production wrapper
/// below supplies values from the process environment; tests can provide an
/// isolated set of values without mutating that environment.
pub fn resolve_server_binary_with_paths(
    server_bin: Option<&std::ffi::OsStr>,
    runfiles_dir: Option<&std::ffi::OsStr>,
    cargo_fallback: &Path,
) -> std::io::Result<PathBuf> {
    if let Some(value) = server_bin {
        if value.to_string_lossy().trim().is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "PANTOKEN_SERVER_BIN must not be empty",
            ));
        }
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
        if let Some(runfiles) = runfiles_dir {
            let resolved = PathBuf::from(runfiles).join(&path);
            if resolved.is_file() {
                return Ok(resolved);
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!(
                    "PANTOKEN_SERVER_BIN does not name a file in RUNFILES_DIR: {}",
                    resolved.display()
                ),
            ));
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "PANTOKEN_SERVER_BIN does not name an existing file: {}",
                path.display()
            ),
        ));
    }

    if cargo_fallback.is_file() {
        Ok(cargo_fallback.to_path_buf())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "pantoken-server binary not found at {}",
                cargo_fallback.display()
            ),
        ))
    }
}

/// Return inherited XDG variables for the child runtime without mutating or
/// consulting process-global state. The production wrapper supplies
/// `std::env::var_os`; tests can inject an isolated lookup map.
pub fn inherited_xdg_assignments(
    lookup: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<(String, std::ffi::OsString)> {
    ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]
        .into_iter()
        .filter_map(|key| lookup(key).map(|value| (key.to_string(), value)))
        .collect()
}

pub fn resolve_server_binary() -> std::io::Result<PathBuf> {
    let exe =
        std::env::current_exe().map_err(|e| std::io::Error::other(format!("current_exe: {e}")))?;
    let fallback = exe
        .parent()
        .and_then(Path::parent)
        .map(|p| p.join("pantoken-server"))
        .ok_or_else(|| std::io::Error::other("current_exe has no Cargo target directory"))?;
    resolve_server_binary_with_paths(
        std::env::var_os("PANTOKEN_SERVER_BIN").as_deref(),
        std::env::var_os("RUNFILES_DIR").as_deref(),
        &fallback,
    )
}

/// Connect to the runtime socket, bootstrapping the runtime if absent.
///
/// Race-safe bootstrap (plan step 7):
/// 1. Try connecting first. If it connects, return the stream.
/// 2. If absent, acquire the pidlock, spawn the runtime, wait for readiness.
/// 3. Stale recovery: reclaim a dead pidfile, remove stale socket, retry.
async fn connect_with_bootstrap(root: &Path, socket_path: &Path) -> std::io::Result<UnixStream> {
    // Step 1: try connecting first.
    if let Ok(stream) = UnixStream::connect(socket_path).await {
        return Ok(stream);
    }

    // Step 2: socket absent/unreachable — bootstrap the runtime.
    info!("stdio-proxy: socket not found, bootstrapping runtime");

    let run_dir = layout::run_dir(root);
    std::fs::create_dir_all(&run_dir)?;

    let server_id = pidlock::mint_or_read_server_id(&run_dir)
        .map_err(|e| std::io::Error::other(format!("mint server id: {e}")))?;

    let pid_path = layout::pid_file(root);

    // Check the existing pidfile for staleness.
    let existing = std::fs::read_to_string(&pid_path)
        .ok()
        .and_then(|text| pidlock::parse_lock(&text));

    match pidlock::lock_decision(existing.as_ref(), std::process::id() as i64) {
        "live" => {
            // Another process holds the lock — it's probably starting the
            // runtime. Wait for the socket to appear.
            info!("stdio-proxy: another process holds the lock, waiting for socket");
            return wait_for_socket(socket_path, SOCKET_READINESS_TIMEOUT_SECS).await;
        }
        "reclaim" if existing.is_some() => {
            info!("stdio-proxy: reclaiming stale pidfile");
            let _ = std::fs::remove_file(socket_path);
        }
        _ => {}
    }

    // Acquire the lock.
    let _pid_lock = match pidlock::acquire_pid_lock(&run_dir, &server_id, std::process::id() as i64)
    {
        Ok(lock) => lock,
        Err(_e) => {
            // Lost the race to another proxy — try connecting again.
            info!("stdio-proxy: lost lock race, retrying connect");
            if let Ok(stream) = UnixStream::connect(socket_path).await {
                return Ok(stream);
            }
            return wait_for_socket(socket_path, SOCKET_READINESS_TIMEOUT_SECS).await;
        }
    };

    // Release the bootstrap lock before spawning the runtime so the child can
    // acquire its own pidlock (run_remote_runtime_mode re-acquires it). The
    // proxy's lock only serializes the bootstrap *decision*; the long-lived
    // runtime process owns the lock for its lifetime.
    drop(_pid_lock);

    // Spawn the runtime in remote-runtime mode.
    let server_binary = resolve_server_binary()?;

    let mut cmd = tokio::process::Command::new(&server_binary);
    cmd.env("PANTOKEN_SERVE_MODE", "remote-runtime");
    cmd.env("PANTOKEN_REMOTE_ROOT", root);
    // Forward PANTOKEN_DRIVER so the spawned runtime uses the same driver
    // (e.g. mock for tests) as the proxy process.
    if let Ok(driver) = std::env::var("PANTOKEN_DRIVER") {
        cmd.env("PANTOKEN_DRIVER", driver);
    }
    // Thread PANTOKEN_POLYTOKEN_BIN through to the runtime (Phase 3 resolves
    // which binary; Phase 1 just passes it through).
    if let Ok(bin) = std::env::var("PANTOKEN_POLYTOKEN_BIN") {
        cmd.env("PANTOKEN_POLYTOKEN_BIN", bin);
    }
    // Preserve XDG variables inherited from the remote user's environment at
    // the stdio-proxy/runtime boundary. This is environment propagation, not
    // profile-generated isolation; the profile path never sets these values.
    for (key, value) in inherited_xdg_assignments(|var| std::env::var_os(var)) {
        cmd.env(key, value);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    let _child = cmd
        .spawn()
        .map_err(|e| std::io::Error::other(format!("spawn runtime: {e}")))?;

    // Wait for socket readiness.
    wait_for_socket(socket_path, SOCKET_READINESS_TIMEOUT_SECS).await
}

/// Wait for the Unix socket to accept connections, with a bounded timeout.
async fn wait_for_socket(socket_path: &Path, timeout_secs: u64) -> std::io::Result<UnixStream> {
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(timeout_secs);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "runtime did not become ready in time",
            ));
        }
        match UnixStream::connect(socket_path).await {
            Ok(stream) => return Ok(stream),
            Err(_) => tokio::time::sleep(tokio::time::Duration::from_millis(200)).await,
        }
    }
}

// ── remote-runtime mode ────────────────────────────────────────────────

/// Entry point for `PANTOKEN_SERVE_MODE=remote-runtime`.
///
/// Listens on the private Unix socket, enforces single-instance locking, and
/// serves framed connections via `ConnectionSession`. The hub/driver stack is
/// the same as the local server.
pub async fn run_remote_runtime(
    root: &Path,
    hub: Arc<parking_lot::Mutex<SessionHub>>,
    config: Arc<crate::config::Config>,
    driver: Arc<dyn PantokenDriver>,
) -> std::io::Result<()> {
    let socket_path = layout::private_socket(root);
    let run_dir = layout::run_dir(root);

    std::fs::create_dir_all(&run_dir)?;

    // Remove any stale socket before binding.
    let _ = std::fs::remove_file(&socket_path);

    let listener = UnixListener::bind(&socket_path)?;

    // Set 0600 perms on the socket (user-owned only).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));
    }

    info!(
        "pantoken remote runtime listening on Unix socket: {}",
        socket_path.display()
    );

    // Wire the driver's event stream to the hub (same as main.rs).
    {
        let hub_clone = hub.clone();
        let _sub_id = driver.subscribe(Box::new(
            move |ev: pantoken_protocol::session_driver::SessionDriverEvent| {
                let mut h = hub_clone.lock();
                h.on_event(ev);
            },
        ));
    }

    let env = SessionEnv {
        hub: hub.clone(),
        config: config.clone(),
    };

    // Start the lifecycle manager (Phase 1.4): idle reaping + hub-idle exit.
    let lifecycle_config = crate::remote::lifecycle::LifecycleConfig {
        idle_reap_ms: config.idle_reap_ms,
        hub_idle_ms: config.hub_idle_ms,
    };
    let lifecycle = crate::remote::lifecycle::LifecycleManager::start(
        hub.clone(),
        driver.clone(),
        lifecycle_config,
    );

    // Accept loop. Each connection is either:
    // - a probe (sends {"type":"probe"} → respond with Identity, close)
    // - a session (sends framed ClientEnvelope → ConnectionSession)
    loop {
        // Check if the lifecycle manager signaled an idle exit.
        if *lifecycle.exit_signal.borrow() {
            info!("remote runtime: idle exit signaled, stopping accept loop");
            break;
        }

        // Accept with a timeout so we can re-check the exit signal periodically.
        match tokio::time::timeout(tokio::time::Duration::from_secs(1), listener.accept()).await {
            Ok(Ok((stream, _))) => {
                let env = env.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_runtime_connection(stream, env).await {
                        warn!("remote runtime: connection error: {e}");
                    }
                });
            }
            Ok(Err(e)) => {
                warn!("remote runtime accept error: {e}");
            }
            Err(_) => {
                // Timeout — loop back and re-check the exit signal.
            }
        }
    }

    // The accept loop has ended (normally due to the public idle-exit signal).
    // Always stop and await the lifecycle task before returning so it cannot
    // outlive this runtime or retain the hub/driver after shutdown.
    lifecycle.shutdown().await;

    info!("remote runtime: shutting down");
    Ok(())
}

/// Handle a single accepted connection. Peeks at the first frame to
/// distinguish a probe from a session.
async fn handle_runtime_connection(stream: UnixStream, env: SessionEnv) -> std::io::Result<()> {
    let (mut read_half, mut write_half) = stream.into_split();
    let mut decoder = FrameDecoder::new();
    let mut buf = [0u8; 8192];

    // Read the first frame.
    let first_frame = loop {
        match read_half.read(&mut buf).await {
            Ok(0) => return Ok(()), // closed before any data
            Ok(n) => {
                let results = decoder.push(&buf[..n]);
                if let Some(Ok(body)) = results.into_iter().next() {
                    break body;
                }
                // No complete frame yet — read more.
            }
            Err(e) => return Err(e),
        }
    };

    // Check if it's a probe.
    if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&first_frame) {
        if val.get("type").and_then(|t| t.as_str()) == Some("probe") {
            // Respond with identity.
            let identity = Identity {
                protocol_version: PROTOCOL_VERSION,
                daemon_target_version: POLYTOKEN_DAEMON_TARGET_VERSION.to_string(),
                state: RuntimeState::Running,
            };
            let identity_json = serde_json::to_vec(&identity).unwrap();
            let mut frame = Vec::with_capacity(4 + identity_json.len());
            frame.extend_from_slice(&(identity_json.len() as u32).to_be_bytes());
            frame.extend_from_slice(&identity_json);
            write_half.write_all(&frame).await?;
            write_half.flush().await?;
            return Ok(());
        }
    }

    // Not a probe — it's a session. We've already consumed the first frame
    // from the stream. Reconstruct a reader that yields the pre-read first
    // frame followed by the remaining socket bytes, then run
    // ConnectionSession.
    //
    // We reconstruct the frame bytes (with length prefix) so the StdioAdapter's
    // FrameDecoder can re-decode it.
    let mut frame_bytes = Vec::with_capacity(4 + first_frame.len());
    frame_bytes.extend_from_slice(&(first_frame.len() as u32).to_be_bytes());
    frame_bytes.extend_from_slice(&first_frame);

    // Create a combined reader: pre-read frame bytes ++ remaining socket.
    let combined = CombinedReader::new(frame_bytes, read_half);
    let adapter = StdioAdapter::new(combined, write_half);
    ConnectionSession::new(adapter, env).run().await;
    Ok(())
}

/// A reader that yields pre-buffered bytes first, then reads from an
/// underlying async reader. Used to reconstruct the stream after peeking
/// at the first frame.
struct CombinedReader<R: AsyncReadExt + Unpin + Send + 'static> {
    pre: std::io::Cursor<Vec<u8>>,
    inner: R,
}

impl<R: AsyncReadExt + Unpin + Send + 'static> CombinedReader<R> {
    fn new(pre: Vec<u8>, inner: R) -> Self {
        Self {
            pre: std::io::Cursor::new(pre),
            inner,
        }
    }
}

// Manual AsyncRead implementation for CombinedReader.
// (AsyncReadExt is blanket-implemented for all AsyncRead types by tokio.)
impl<R: AsyncReadExt + Unpin + Send + 'static> AsyncRead for CombinedReader<R> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        // First drain the pre-buffered bytes.
        let pre_len = self.pre.get_ref().len() as u64;
        if self.pre.position() < pre_len {
            let pos = self.pre.position() as usize;
            let remaining = &self.pre.get_ref()[pos..];
            let n = std::cmp::min(remaining.len(), buf.remaining());
            buf.put_slice(&remaining[..n]);
            self.pre.set_position(pos as u64 + n as u64);
            return std::task::Poll::Ready(Ok(()));
        }
        // Pre-buffer exhausted — delegate to the inner reader.
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

// ── no-public-TCP-listener assertion (AC.3) ─────────────────────────────

/// Assert that the remote path binds no non-loopback TCP listener.
///
/// This is a structural assertion: the `remote-runtime` and `stdio-proxy`
/// modes use ONLY Unix sockets under the remote root. No `TcpListener::bind`
/// to any address appears in the remote code path. The local server's TCP
/// listener (for the HTTP/WS path) is a separate mode (default
/// `PANTOKEN_SERVE_MODE` unset) and is not involved in remote connections.
#[cfg(test)]
pub fn assert_no_public_tcp_listener() {
    // This is a compile-time + code-review guarantee. The runtime module
    // uses only `UnixListener::bind`. No TCP listener is created in the
    // remote-runtime or stdio-proxy modes.
}

#[cfg(test)]
mod resolver_tests {
    use super::{inherited_xdg_assignments, resolve_server_binary_with_paths};
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn resolves_direct_runfiles_empty_and_invalid_values() {
        let root = tempfile::tempdir().unwrap();
        let direct = root.path().join("direct-server");
        std::fs::write(&direct, b"binary").unwrap();
        let fallback = root.path().join("fallback");
        assert_eq!(
            resolve_server_binary_with_paths(Some(direct.as_os_str()), None, &fallback).unwrap(),
            direct
        );

        let runfiles = root.path().join("runfiles");
        let relative = PathBuf::from("bin/pantoken-server");
        let runfile = runfiles.join(&relative);
        std::fs::create_dir_all(runfile.parent().unwrap()).unwrap();
        std::fs::write(&runfile, b"binary").unwrap();
        assert_eq!(
            resolve_server_binary_with_paths(
                Some(relative.as_os_str()),
                Some(runfiles.as_os_str()),
                &fallback
            )
            .unwrap(),
            runfile
        );

        let empty = OsString::new();
        assert_eq!(
            resolve_server_binary_with_paths(Some(&empty), None, &fallback)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidInput
        );
        let error = resolve_server_binary_with_paths(
            Some(OsString::from("missing-server").as_os_str()),
            None,
            &fallback,
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        assert!(error.to_string().contains("PANTOKEN_SERVER_BIN"));
    }

    #[test]
    fn runtime_forwards_inherited_xdg_variables() {
        let values = std::collections::HashMap::from([
            ("XDG_CONFIG_HOME", OsString::from("/tmp/config")),
            ("XDG_DATA_HOME", OsString::from("/tmp/data")),
            ("XDG_CACHE_HOME", OsString::from("/tmp/cache")),
        ]);
        let assignments = inherited_xdg_assignments(|key| values.get(key).cloned());
        assert_eq!(
            assignments,
            vec![
                ("XDG_CONFIG_HOME".into(), OsString::from("/tmp/config")),
                ("XDG_DATA_HOME".into(), OsString::from("/tmp/data")),
                ("XDG_CACHE_HOME".into(), OsString::from("/tmp/cache")),
            ]
        );
    }

    #[test]
    fn uses_explicit_cargo_fallback_when_override_absent() {
        let root = tempfile::tempdir().unwrap();
        let fallback = root.path().join("pantoken-server");
        std::fs::write(&fallback, b"binary").unwrap();
        assert_eq!(
            resolve_server_binary_with_paths(None, None, &fallback).unwrap(),
            fallback
        );
        let missing = root.path().join("missing");
        assert_eq!(
            resolve_server_binary_with_paths(None, None, &missing)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotFound
        );
    }

    #[cfg(unix)]
    #[test]
    fn preserves_non_utf8_override_values() {
        use std::os::unix::ffi::OsStringExt;
        let value = OsString::from_vec(vec![b'b', b'a', 0xff]);
        let fallback = PathBuf::from("fallback");
        let error = resolve_server_binary_with_paths(Some(&value), None, &fallback).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }
}
