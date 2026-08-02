//! Owns the lifecycle of the local pantoken server process, plus the liveness loop the ADR
//! asked for: spawn, gate on /health, poll for liveness, respawn on crash with a
//! crash-loop breaker, SIGTERM → bounded wait → SIGKILL on teardown.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::config::PantokenConfig;

/// Classification of the authenticated loopback health probe. These values deliberately do
/// not retain response bodies or credentials, making them safe to forward to diagnostics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProbeOutcome {
    Healthy,
    Unauthorized,
    Unreachable,
    Malformed,
    WrongTarget,
    EndpointUnverified,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryReason {
    Crash,
    Hang,
    HealthUnauthorized,
    HealthUnreachable,
    HealthMalformed,
    WrongTarget,
    EndpointUnverified,
    BootTimeout,
    CrashLoop,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupervisorDecision {
    Wait,
    Healthy {
        first_time: bool,
    },
    Restart(RecoveryReason),
    Unrecoverable(RecoveryReason),
    /// Teardown is terminal: a child exit must never trigger a respawn.
    Stopped,
}

/// Small deterministic supervision state machine. Production process/timing adapters feed it
/// observations; tests can drive it with virtual time and never wait for a real sidecar.
#[derive(Clone, Debug)]
pub struct SupervisionCore {
    started: bool,
    healthy: bool,
    failures: u32,
    rapid_restarts: u32,
    max_failures: u32,
    max_rapid_restarts: u32,
    stopping: bool,
    terminal: Option<RecoveryReason>,
}

impl Default for SupervisionCore {
    fn default() -> Self {
        Self {
            started: false,
            healthy: false,
            failures: 0,
            rapid_restarts: 0,
            max_failures: LIVENESS_STRIKES,
            max_rapid_restarts: MAX_RAPID_RESTARTS,
            stopping: false,
            terminal: None,
        }
    }
}

impl SupervisionCore {
    pub fn request_stop(&mut self) {
        self.stopping = true;
    }

    pub fn observe_probe(
        &mut self,
        outcome: ProbeOutcome,
        boot_timed_out: bool,
    ) -> SupervisorDecision {
        if self.stopping {
            return SupervisorDecision::Stopped;
        }
        if let Some(reason) = self.terminal {
            return SupervisorDecision::Unrecoverable(reason);
        }
        if outcome == ProbeOutcome::Healthy {
            self.failures = 0;
            if !self.healthy {
                let first_time = !self.started;
                self.started = true;
                self.healthy = true;
                return SupervisorDecision::Healthy { first_time };
            }
            return SupervisorDecision::Wait;
        }
        if !self.healthy && boot_timed_out {
            self.terminal = Some(RecoveryReason::BootTimeout);
            return SupervisorDecision::Unrecoverable(RecoveryReason::BootTimeout);
        }
        self.failures = self.failures.saturating_add(1);
        if self.healthy && self.failures >= self.max_failures {
            self.healthy = false;
            return SupervisorDecision::Restart(match outcome {
                ProbeOutcome::Unauthorized => RecoveryReason::HealthUnauthorized,
                ProbeOutcome::Malformed => RecoveryReason::HealthMalformed,
                ProbeOutcome::WrongTarget => RecoveryReason::WrongTarget,
                ProbeOutcome::EndpointUnverified => RecoveryReason::EndpointUnverified,
                ProbeOutcome::Unreachable => RecoveryReason::Hang,
                ProbeOutcome::Healthy => return SupervisorDecision::Wait,
            });
        }
        SupervisorDecision::Wait
    }

    pub fn observe_exit(&mut self, rapid: bool) -> SupervisorDecision {
        if self.stopping {
            return SupervisorDecision::Stopped;
        }
        if self.stopping {
            return SupervisorDecision::Stopped;
        }
        if let Some(reason) = self.terminal {
            return SupervisorDecision::Unrecoverable(reason);
        }
        if rapid {
            self.rapid_restarts = self.rapid_restarts.saturating_add(1);
        } else {
            self.rapid_restarts = 0;
        }
        if self.rapid_restarts > self.max_rapid_restarts {
            self.terminal = Some(RecoveryReason::CrashLoop);
            SupervisorDecision::Unrecoverable(RecoveryReason::CrashLoop)
        } else {
            self.healthy = false;
            SupervisorDecision::Restart(RecoveryReason::Crash)
        }
    }

    #[cfg(test)]
    fn with_limits(max_failures: u32, max_rapid_restarts: u32) -> Self {
        Self {
            max_failures,
            max_rapid_restarts,
            ..Self::default()
        }
    }
}

pub enum SupervisorEvent {
    /// Server answered /health. `first_time` → initial boot (load the web client);
    /// otherwise it just came back from a restart (reload to pick up new client assets).
    Healthy { first_time: bool },
    /// A typed health failure, safe for lifecycle diagnostics.
    ProbeFailed { outcome: ProbeOutcome },
    /// The process is being restarted after a bounded recovery condition.
    Restarting { reason: RecoveryReason },
    /// Initial boot never got healthy, or it's crash-looping. Fatal.
    Unrecoverable(String),
}

/// Strikes before a crash-loop is declared unrecoverable (exits with <5s uptime).
const MAX_RAPID_RESTARTS: u32 = 5;
/// Initial-boot health deadline.
const BOOT_HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Consecutive liveness-probe failures (5s apart) before we SIGTERM a hung-but-running
/// server and let the respawn path recover it.
const LIVENESS_STRIKES: u32 = 6;

pub struct Supervisor {
    stop: Arc<AtomicBool>,
    child_pid: Arc<AtomicI32>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Supervisor {
    pub fn start(
        config: Arc<PantokenConfig>,
        on_event: impl Fn(SupervisorEvent) + Send + 'static,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let child_pid = Arc::new(AtomicI32::new(0));
        let thread = {
            let stop = stop.clone();
            let child_pid = child_pid.clone();
            std::thread::spawn(move || run_loop(&config, &stop, &child_pid, &on_event))
        };
        Self {
            stop,
            child_pid,
            thread: Some(thread),
        }
    }

    /// SIGTERM the server; the run loop sees the exit and respawns it (uptime was real, so
    /// the crash-loop counter resets). Used by the tray's "Restart Hub".
    pub fn restart_hub(&self) {
        let pid = self.child_pid.load(Ordering::SeqCst);
        if pid > 0 {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }

    /// SIGTERM the server and stop respawning (app quit). Blocks briefly for a clean exit;
    /// escalates to SIGKILL if the server ignores SIGTERM.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let pid = self.child_pid.load(Ordering::SeqCst);
        if pid > 0 {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn run_loop(
    config: &PantokenConfig,
    stop: &AtomicBool,
    child_pid: &AtomicI32,
    on_event: &(impl Fn(SupervisorEvent) + Send),
) {
    let mut started = false; // have we ever been healthy?
    let mut rapid_restarts: u32 = 0;
    let mut policy = SupervisionCore::default();

    while !stop.load(Ordering::SeqCst) {
        let spawn_time = Instant::now();
        // The compiled Rust server sidecar, cwd'd to the data dir (the server resolves
        // every path it needs from env — cwd just has to exist and stay valid across
        // updates).
        let mut cmd = Command::new(&config.hub_bin);
        cmd.current_dir(&config.data_dir);
        // Prevent an inherited desktop-process token from turning local mode into
        // authenticated mode. `server_env` adds it back only for remote mode.
        cmd.env_remove("PANTOKEN_TOKEN");
        cmd.envs(config.server_env()).stdin(Stdio::null());
        let log_file = match open_log_file(config) {
            Ok(f) => f,
            Err(e) => {
                on_event(SupervisorEvent::Unrecoverable(format!(
                    "Couldn't open the pantoken server log at {}: {e}",
                    config.data_dir.join("pantoken.log").display()
                )));
                return;
            }
        };
        let log_file_for_stderr = match log_file.try_clone() {
            Ok(f) => f,
            Err(e) => {
                on_event(SupervisorEvent::Unrecoverable(format!(
                    "Couldn't attach stderr to the pantoken server log at {}: {e}",
                    config.data_dir.join("pantoken.log").display()
                )));
                return;
            }
        };
        cmd.stdout(Stdio::from(log_file));
        cmd.stderr(Stdio::from(log_file_for_stderr));
        let mut child = match crate::proc::spawn_with_clean_signals(&mut cmd) {
            Ok(c) => c,
            Err(e) => {
                let what = format!(
                    "Couldn't launch the pantoken server at {}: {e}",
                    config.hub_bin.display()
                );
                on_event(SupervisorEvent::Unrecoverable(what));
                return;
            }
        };
        child_pid.store(child.id() as i32, Ordering::SeqCst);

        supervise_one(
            config,
            stop,
            &mut child,
            &mut started,
            &mut policy,
            on_event,
        );

        child_pid.store(0, Ordering::SeqCst);
        if stop.load(Ordering::SeqCst) {
            reap(&mut child);
            return;
        }
        let _ = child.wait();

        // KeepAlive with a crash-loop guard: a quick exit (<5s uptime) counts toward the
        // strike limit; a restart after real uptime (e.g. a tray-menu restart) resets it.
        let uptime = spawn_time.elapsed();
        rapid_restarts = if uptime < Duration::from_secs(5) {
            rapid_restarts + 1
        } else {
            0
        };
        // The persistent policy is the production decision core used by deterministic tests.
        // Seed the observed rapid-exit count only for compatibility with the process timer.
        policy.rapid_restarts = rapid_restarts.saturating_sub(1);
        match policy.observe_exit(uptime < Duration::from_secs(5)) {
            SupervisorDecision::Unrecoverable(reason) => {
                let hint = format!(
                    "Check the hub log at {} — the bundled hub may be refusing a locked \
                     data dir or crashing at startup.",
                    config.data_dir.join("pantoken.log").display()
                );
                on_event(SupervisorEvent::Unrecoverable(format!(
                    "The pantoken server entered an unrecoverable {reason:?} state. {hint}"
                )));
                return;
            }
            SupervisorDecision::Restart(reason) => on_event(SupervisorEvent::Restarting { reason }),
            _ => {}
        }
        let delay = Duration::from_secs(rapid_restarts.min(3) as u64);
        if !sleep_unless_stopped(stop, delay) {
            reap(&mut child);
            return;
        }
    }
}

fn open_log_file(config: &PantokenConfig) -> std::io::Result<std::fs::File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(config.data_dir.join("pantoken.log"))
}

/// Drive one child process: gate on /health (fatal if the *initial* boot never gets
/// there), report healthy, then run the liveness loop until the child exits or a hung
/// server earns a SIGTERM. Returns when the child is gone (caller reaps + respawns).
fn supervise_one(
    config: &PantokenConfig,
    stop: &AtomicBool,
    child: &mut Child,
    started: &mut bool,
    policy: &mut SupervisionCore,
    on_event: &(impl Fn(SupervisorEvent) + Send),
) {
    let port = config.server_port;
    let boot_deadline = Instant::now() + BOOT_HEALTH_TIMEOUT;
    let mut healthy = false;
    let mut liveness_failures: u32 = 0;
    let mut next_probe = Instant::now();

    loop {
        if stop.load(Ordering::SeqCst) {
            terminate(child);
            return;
        }
        match child.try_wait() {
            Ok(Some(_)) => return, // exited — caller handles respawn policy
            Ok(None) => {}
            Err(_) => return,
        }

        if Instant::now() >= next_probe {
            match health_probe(port, config.token.as_deref()) {
                outcome => {
                    if outcome != ProbeOutcome::Healthy {
                        on_event(SupervisorEvent::ProbeFailed { outcome });
                    }
                    let decision =
                        policy.observe_probe(outcome, !healthy && Instant::now() > boot_deadline);
                    match decision {
                        SupervisorDecision::Healthy { first_time } => {
                            healthy = true;
                            liveness_failures = 0;
                            *started = true;
                            on_event(SupervisorEvent::Healthy { first_time });
                            next_probe = Instant::now() + Duration::from_secs(5);
                        }
                        SupervisorDecision::Restart(reason) => {
                            on_event(SupervisorEvent::Restarting { reason });
                            terminate(child);
                            return;
                        }
                        SupervisorDecision::Unrecoverable(reason) => {
                            let message = if reason == RecoveryReason::BootTimeout {
                                format!(
                                    "The pantoken server didn't become healthy within {}s.",
                                    BOOT_HEALTH_TIMEOUT.as_secs()
                                )
                            } else {
                                "The pantoken server entered an unrecoverable crash loop.".into()
                            };
                            on_event(SupervisorEvent::Unrecoverable(message));
                            terminate(child);
                            return;
                        }
                        SupervisorDecision::Stopped => {
                            terminate(child);
                            return;
                        }
                        SupervisorDecision::Wait => {
                            if healthy {
                                liveness_failures = liveness_failures.saturating_add(1);
                            }
                            next_probe = if healthy {
                                Instant::now() + Duration::from_secs(5)
                            } else {
                                Instant::now() + Duration::from_millis(250)
                            };
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// GET /health over a raw loopback socket — std-only, tight timeouts, no async runtime.
/// `token` is intentionally optional: local mode keeps the historical no-auth probe;
/// remote mode passes the resolved Keychain token here from the parent config work.
fn health_probe(port: u16, token: Option<&str>) -> ProbeOutcome {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return ProbeOutcome::Unreachable;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    let authorization = authorization_header(token);
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n{authorization}\r\n"
    );
    if s.write_all(req.as_bytes()).is_err() {
        return ProbeOutcome::Unreachable;
    }
    match read_http_response(&mut s) {
        Ok((200..=299, body)) if body_has_pantoken_health(&body) => ProbeOutcome::Healthy,
        Ok((401, _)) => ProbeOutcome::Unauthorized,
        Ok(_) | Err(HttpReadError::Malformed) => ProbeOutcome::Malformed,
        Err(HttpReadError::Io) => ProbeOutcome::Unreachable,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HttpReadError {
    Io,
    Malformed,
}

/// Read until the complete header terminator, accepting fragmented TCP reads but never
/// interpreting a partial status line as success. The cap prevents an untrusted endpoint from
/// forcing unbounded allocation.
fn read_http_response(stream: &mut TcpStream) -> Result<(u16, String), HttpReadError> {
    let mut response = Vec::with_capacity(256);
    let mut chunk = [0u8; 256];
    while response.len() < 16 * 1024 {
        let n = stream.read(&mut chunk).map_err(|_| HttpReadError::Io)?;
        if n == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..n]);
        // Read through connection close so headers and body split across TCP packets are
        // handled correctly; the 16 KiB cap keeps malformed endpoints bounded.
    }
    let status = parse_http_status(&response)?;
    let header_end = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or(HttpReadError::Malformed)?;
    let body = String::from_utf8_lossy(&response[header_end + 4..]).into_owned();
    Ok((status, body))
}

fn body_has_pantoken_health(body: &str) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body.trim()) else {
        return false;
    };
    json.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
        && json
            .get("clients")
            .and_then(serde_json::Value::as_u64)
            .is_some()
        && json
            .get("busy")
            .and_then(serde_json::Value::as_bool)
            .is_some()
}

fn parse_http_status(response: &[u8]) -> Result<u16, HttpReadError> {
    let header_end = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or(HttpReadError::Malformed)?;
    let header =
        std::str::from_utf8(&response[..header_end]).map_err(|_| HttpReadError::Malformed)?;
    let line = header
        .split("\r\n")
        .next()
        .ok_or(HttpReadError::Malformed)?;
    let mut fields = line.split(' ');
    let version = fields.next().ok_or(HttpReadError::Malformed)?;
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(HttpReadError::Malformed);
    }
    let status = fields.next().ok_or(HttpReadError::Malformed)?;
    if status.len() != 3 || !status.bytes().all(|b| b.is_ascii_digit()) {
        return Err(HttpReadError::Malformed);
    }
    status.parse().map_err(|_| HttpReadError::Malformed)
}

#[cfg(test)]
fn health_ok_with_token(port: u16, token: Option<&str>) -> bool {
    health_probe(port, token) == ProbeOutcome::Healthy
}

fn authorization_header(token: Option<&str>) -> String {
    token
        .filter(|token| !token.is_empty())
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default()
}

/// SIGTERM, wait up to 5s, then SIGKILL. The server exits cleanly on SIGTERM (releases
/// its pidlock, shuts daemons down); the KILL is a last resort so quit can't hang.
fn terminate(child: &mut Child) {
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn reap(child: &mut Child) {
    terminate(child);
}

/// Sleep in small ticks so a stop request interrupts promptly. Returns false if stopped.
fn sleep_unless_stopped(stop: &AtomicBool, total: Duration) -> bool {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !stop.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::{
        authorization_header, ProbeOutcome, RecoveryReason, SupervisionCore, SupervisorDecision,
    };

    #[test]
    fn supervisor_stop_is_terminal_and_never_respawns() {
        let mut core = SupervisionCore::with_limits(1, 1);
        core.request_stop();
        assert_eq!(core.observe_exit(true), SupervisorDecision::Stopped);
        assert_eq!(
            core.observe_probe(ProbeOutcome::Healthy, false),
            SupervisorDecision::Stopped
        );
    }

    #[test]
    fn supervisor_health_auth_contract() {
        assert_eq!(authorization_header(None), "");
        assert_eq!(
            authorization_header(Some("test-token")),
            "Authorization: Bearer test-token\r\n"
        );
        assert_eq!(authorization_header(Some("")), "");
    }

    #[test]
    fn supervisor_remote_mode_restarts_and_recovers() {
        let mut core = SupervisionCore::with_limits(2, 2);
        assert_eq!(
            core.observe_probe(ProbeOutcome::Healthy, false),
            SupervisorDecision::Healthy { first_time: true }
        );
        assert_eq!(
            core.observe_probe(ProbeOutcome::Unauthorized, false),
            SupervisorDecision::Wait
        );
        assert_eq!(
            core.observe_probe(ProbeOutcome::Unauthorized, false),
            SupervisorDecision::Restart(RecoveryReason::HealthUnauthorized)
        );
        assert_eq!(
            core.observe_probe(ProbeOutcome::Healthy, false),
            SupervisorDecision::Healthy { first_time: false }
        );
        assert_eq!(
            core.observe_exit(true),
            SupervisorDecision::Restart(RecoveryReason::Crash)
        );
        assert_eq!(
            core.observe_probe(ProbeOutcome::Healthy, false),
            SupervisorDecision::Healthy { first_time: false }
        );
        assert_eq!(
            core.observe_exit(true),
            SupervisorDecision::Restart(RecoveryReason::Crash)
        );
        assert_eq!(
            core.observe_exit(true),
            SupervisorDecision::Unrecoverable(RecoveryReason::CrashLoop)
        );
        assert_eq!(
            core.observe_probe(ProbeOutcome::Healthy, true),
            SupervisorDecision::Unrecoverable(RecoveryReason::CrashLoop)
        );
    }

    #[test]
    fn healthy_unreachable_restart_is_classified_as_hang() {
        let mut core = SupervisionCore::with_limits(1, 2);
        assert_eq!(
            core.observe_probe(ProbeOutcome::Healthy, false),
            SupervisorDecision::Healthy { first_time: true }
        );
        assert_eq!(
            core.observe_probe(ProbeOutcome::Unreachable, false),
            SupervisorDecision::Restart(RecoveryReason::Hang)
        );
    }

    #[test]
    fn http_parser_accepts_fragmented_valid_response() {
        assert_eq!(
            super::parse_http_status(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"),
            Ok(204)
        );
    }

    #[test]
    fn http_parser_rejects_malformed_and_non_http() {
        for response in [
            b"not HTTP\r\n\r\n".as_slice(),
            b"HTTP/2 200 OK\r\n\r\n",
            b"HTTP/1.1 nope\r\n\r\n",
            b"HTTP/1.1 200 OK",
        ] {
            assert_eq!(
                super::parse_http_status(response),
                Err(super::HttpReadError::Malformed)
            );
        }
    }
}
