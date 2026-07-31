//! Classification of errors that can occur while restoring (opening) a cold
//! session. See docs/TODO.md: "analyze all kinds of errors that restoring a
//! session can return... some of them shouldn't be retried. For example,
//! trying to restore a session that was run in a directory that no longer
//! exists can't ever succeed."
//!
//! `open_session`'s cold path is: resolve the session id + cwd from the
//! on-disk registry -> try to ATTACH to an already-running daemon (if
//! `startup.json` names one) -> on failure/absence, COLD-START a fresh resume
//! daemon (`polytoken daemon --resume --project-dir <cwd> ...`) -> claim the
//! attachment lease -> fetch state -> subscribe to SSE. Each stage fails for
//! an independent reason; this module gives each reason one name and says
//! whether retrying — including `open_session`'s own attach -> cold-start
//! fallback — could ever change the outcome. The MissingCwd fail-fast itself
//! is a separate pre-flight `is_dir()` guard in `open_session`; here,
//! `classify()` names the reason and `is_permanent()` picks the log severity
//! at the propagation point (`error!` for permanent, `warn!` for transient).
//! The user-facing message is owned by the hub's `classify_switch_error`.

/// A session-restore failure, classified by whether a retry could help.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreErrorClass {
    /// The session's project directory no longer exists on disk (moved,
    /// deleted, an unmounted volume, …). `polytoken daemon --resume
    /// --project-dir <cwd>` cannot succeed until the directory reappears —
    /// permanent. This is the concrete case from docs/TODO.md.
    MissingCwd,
    /// The daemon process itself refused to start: `startup.json` recorded
    /// `state:"failed"` (its own config/session validation rejected the
    /// resume), or the process exited before writing a ready `startup.json`.
    /// The daemon already tried once and gave up with the exact inputs a
    /// retry would repeat — permanent until the underlying cause (bad
    /// config, corrupt session data) is fixed by hand.
    DaemonStartupFailure,
    /// The daemon rejected our bearer credential (401) or a request came
    /// back "unauthorized" during a COLD-START. We just minted the
    /// credential file ourselves for this spawn, so a 401 here means pantoken
    /// and the daemon disagree about the auth protocol (version skew) —
    /// retrying the exact same spawn reproduces it. Permanent.
    ///
    /// (This class is only meaningful for cold-start errors. On the ATTACH
    /// path a 401 usually just means a stale credential for a dead daemon;
    /// `open_session` already treats any attach failure as "fall back to
    /// cold-start" without classifying it, which is the correct handling —
    /// see the caller.)
    AuthFailure,
    /// HTTP 409 — another TUI (or another pantoken instance) already holds
    /// the attachment lease. Transient: the lease lapses on its own (~30s)
    /// or the other client detaches.
    LeaseConflict,
    /// Connection refused, request timeout, the daemon never bound its port,
    /// or its `/health` never came back healthy in time. Environment-
    /// dependent (slow machine, transient port contention, a wedged
    /// process) — a later attempt may well succeed.
    Unreachable,
    /// Anything not recognized above. Deliberately NOT permanent: an
    /// unrecognized shape is exactly the case where refusing to retry could
    /// wrongly strand a recoverable session, so unknown errors are treated
    /// as transient rather than guessed at.
    Other,
}

impl RestoreErrorClass {
    /// True when no amount of retrying — including `open_session`'s own
    /// attach -> cold-start-spawn fallback — can change the outcome. Callers
    /// should fail fast and tell the user why, rather than pay for (or
    /// repeat) a doomed spawn.
    pub fn is_permanent(&self) -> bool {
        matches!(
            self,
            RestoreErrorClass::MissingCwd
                | RestoreErrorClass::DaemonStartupFailure
                | RestoreErrorClass::AuthFailure
        )
    }

    /// Classify a raw error string as produced by the daemon-client/spawn
    /// layer. Pure and string-based because those errors cross the
    /// `PantokenDriver` trait as opaque `Result<_, String>` — this is the one
    /// place that sniffs the text, so no one else has to.
    ///
    /// `MissingCwd` is normally caught before this is ever called —
    /// `open_session` checks the cwd directly with `Path::is_dir()`, no
    /// string sniffing needed for the primary case. The pattern here is a
    /// defense-in-depth fallback (only matching OUR OWN precise wording, not
    /// a generic OS "not found" string — that would also match an unrelated
    /// missing-daemon-binary spawn failure and misattribute it).
    pub fn classify(raw: &str) -> Self {
        if raw.contains("session directory no longer exists") || raw.contains("no such directory:")
        {
            return Self::MissingCwd;
        }
        if raw.contains("polytoken daemon failed to start:")
            || raw.contains("polytoken daemon exited early")
        {
            return Self::DaemonStartupFailure;
        }
        if raw.contains("lease claim failed (401)") || raw.contains("unauthorized") {
            return Self::AuthFailure;
        }
        if raw.contains("another TUI is attached") || raw.contains("lease claim failed (409)") {
            return Self::LeaseConflict;
        }
        if raw.contains("lease claim failed (0)")
            || raw.contains("request timed out")
            || raw.contains("did not become ready within")
            || raw.contains("did not become healthy within")
            || raw.contains("daemon health probe failed")
            || raw.contains("ECONNREFUSED")
            || raw.contains("fetch failed")
        {
            return Self::Unreachable;
        }
        Self::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_cwd_is_permanent() {
        assert!(RestoreErrorClass::MissingCwd.is_permanent());
        assert_eq!(
            RestoreErrorClass::classify("session directory no longer exists: /tmp/gone"),
            RestoreErrorClass::MissingCwd
        );
        // Defense-in-depth wording shared with `new_session`'s existing guard.
        assert_eq!(
            RestoreErrorClass::classify("no such directory: /tmp/gone"),
            RestoreErrorClass::MissingCwd
        );
    }

    #[test]
    fn daemon_startup_failure_is_permanent() {
        assert!(RestoreErrorClass::DaemonStartupFailure.is_permanent());
        assert_eq!(
            RestoreErrorClass::classify("polytoken daemon failed to start: bad config"),
            RestoreErrorClass::DaemonStartupFailure
        );
        assert_eq!(
            RestoreErrorClass::classify("polytoken daemon exited early (status 1):\nstderr: boom"),
            RestoreErrorClass::DaemonStartupFailure
        );
    }

    #[test]
    fn auth_failure_is_permanent() {
        assert!(RestoreErrorClass::AuthFailure.is_permanent());
        assert_eq!(
            RestoreErrorClass::classify("lease claim failed (401): bad token"),
            RestoreErrorClass::AuthFailure
        );
        assert_eq!(
            RestoreErrorClass::classify("request failed: unauthorized"),
            RestoreErrorClass::AuthFailure
        );
    }

    #[test]
    fn lease_conflict_is_not_permanent() {
        assert!(!RestoreErrorClass::LeaseConflict.is_permanent());
        assert_eq!(
            RestoreErrorClass::classify("lease claim failed (409): held by other"),
            RestoreErrorClass::LeaseConflict
        );
        assert_eq!(
            RestoreErrorClass::classify("another TUI is attached to this session"),
            RestoreErrorClass::LeaseConflict
        );
    }

    #[test]
    fn unreachable_classes_are_not_permanent() {
        for raw in [
            "lease claim failed (0): connection refused",
            "request timed out reaching daemon",
            "polytoken daemon did not become ready within 15000ms",
            "daemon did not become healthy within 10000ms",
            "daemon health probe failed",
            "connect ECONNREFUSED 127.0.0.1:4000",
            "fetch failed",
        ] {
            let class = RestoreErrorClass::classify(raw);
            assert_eq!(
                class,
                RestoreErrorClass::Unreachable,
                "misclassified: {raw}"
            );
            assert!(!class.is_permanent(), "should not be permanent: {raw}");
        }
    }

    #[test]
    fn unknown_error_defaults_to_other_and_is_not_permanent() {
        let class = RestoreErrorClass::classify("something totally unexpected");
        assert_eq!(class, RestoreErrorClass::Other);
        assert!(!class.is_permanent());
    }

    #[test]
    fn missing_daemon_binary_is_not_misclassified_as_missing_cwd() {
        // A missing polytoken binary produces the same OS-level "No such file
        // or directory" text as a missing cwd would if we ever OS-spawned
        // into it — the classifier must not conflate the two (see the doc
        // comment on `classify`). It should NOT match MissingCwd; it falls
        // back to Other rather than being misattributed.
        let class = RestoreErrorClass::classify(
            "failed to spawn polytoken daemon: No such file or directory (os error 2)",
        );
        assert_ne!(class, RestoreErrorClass::MissingCwd);
    }
}
