//! Process-spawn helper for the supervisor.

use std::os::unix::process::CommandExt;
use std::process::{Child, Command};

/// Spawn with an EMPTY signal mask. main() blocks SIGTERM/SIGINT process-wide for the
/// sigwait thread, and the mask survives fork+exec — without this reset the hub would
/// be born deaf to SIGTERM, breaking our teardown.
pub fn spawn_with_clean_signals(cmd: &mut Command) -> std::io::Result<Child> {
    prepare_clean_signals(cmd);
    cmd.spawn()
}

/// Reset the signal mask to empty in the child's pre-exec hook. main() blocks
/// SIGTERM/SIGINT process-wide (for the sigwait thread); the block survives
/// fork+exec, so without this reset any spawned child (hub, ssh proxy) would
/// be born deaf to SIGTERM, breaking teardown.
///
/// Use this from std spawn paths. The bridge uses
/// [`prepare_clean_signals_async`] because it spawns via
/// `tokio::process::Command`.
pub fn prepare_clean_signals(cmd: &mut Command) {
    unsafe {
        cmd.pre_exec(reset_sigmask);
    }
}

/// Tokio-process variant of [`prepare_clean_signals`]: installs the same
/// pre-exec sigmask reset on a `tokio::process::Command`.
pub fn prepare_clean_signals_async(cmd: &mut tokio::process::Command) {
    // SAFETY: pre_exec runs in the forked child before exec; the only
    // operation is resetting the signal mask, which is signal-safe.
    unsafe {
        cmd.pre_exec(reset_sigmask);
    }
}

fn reset_sigmask() -> std::io::Result<()> {
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut set);
        libc::pthread_sigmask(libc::SIG_SETMASK, &set, std::ptr::null_mut());
    }
    Ok(())
}
