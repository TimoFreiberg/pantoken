//! Server configuration from the environment. Defaults are safe for local dev;
//! the deploy sets PANTOKEN_TOKEN and runs behind `tailscale serve`.
//
// Port of `server/src/config.ts`.

use std::path::{Path, PathBuf};

/// Default data dir, XDG-conformant: `$XDG_DATA_HOME/pantoken`, falling back to
/// `~/.local/share/pantoken`. This is DATA (persists across restarts, precious user
/// state) — session worktrees hold real user work, conversation history is user data,
/// and the archive/worktree indices are sources of truth, not caches. Pre-0.6 this
/// lived under `~/.local/state/pantoken`; `migrate_legacy_data_dir()` moves existing
/// installs on startup.
fn default_data_dir() -> PathBuf {
    let data_home = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs().join(".local").join("share"));
    data_home.join("pantoken")
}

/// Legacy default data dir (pre-0.6): `~/.local/state/pantoken`. Used by
/// `migrate_legacy_data_dir` to find and move pre-existing installs.
pub fn legacy_data_dir() -> PathBuf {
    let state_home = std::env::var("XDG_STATE_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs().join(".local").join("state"));
    state_home.join("pantoken")
}

/// One-time migration: if the legacy `~/.local/state/pantoken` exists and the new
/// `~/.local/share/pantoken` does not, rename old → new. If both exist, the new
/// dir wins (leave the old one in place — the user can clean it up manually). If
/// `PANTOKEN_DATA_DIR` is set explicitly, the legacy default is irrelevant (the
/// user chose their dir), so this is a no-op. Idempotent and best-effort: a
/// failed rename logs a warning but does not abort startup (the server will just
/// create a fresh data dir in the default location).
pub fn migrate_legacy_data_dir(cfg: &Config) {
    // Only migrate when using the default data dir (no explicit PANTOKEN_DATA_DIR).
    if std::env::var("PANTOKEN_DATA_DIR").is_ok() {
        return;
    }
    let legacy = legacy_data_dir();
    if !legacy.exists() {
        return;
    }
    // New dir already exists — both present, new wins. Don't clobber.
    if cfg.data_dir.exists() {
        return;
    }
    if let Some(parent) = cfg.data_dir.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!(
                "pantoken: migration: could not create {}: {e}",
                parent.display()
            );
            return;
        }
    }
    match std::fs::rename(&legacy, &cfg.data_dir) {
        Ok(()) => {
            eprintln!(
                "pantoken: migrated data dir {} → {}",
                legacy.display(),
                cfg.data_dir.display()
            );
        }
        Err(e) => {
            // rename can fail across filesystems; fall back to leaving the
            // legacy dir and letting the server create a fresh new one.
            eprintln!(
                "pantoken: migration: could not rename {} → {}: {e}; leaving legacy in place",
                legacy.display(),
                cfg.data_dir.display()
            );
        }
    }
}

/// Home directory (cross-platform). Uses the `HOME` env var on Unix, falling back
/// to the system's home dir.
fn dirs() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    // Fallback — unlikely to be reached on a normal Unix system.
    PathBuf::from("/")
}

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    pub vapid_subject: String,
    pub host: String,
    /// None = no auth (dev). When set, WS clients must present it and /debug is gated.
    pub token: Option<String>,
    pub debug: bool,
    /// Built client bundle (served in prod; in dev Vite serves it instead).
    pub client_dist: PathBuf,
    /// Max kept-warm sessions before LRU eviction. ≤0 disables the cap.
    pub warm_cap: i64,
    /// Idle-reap timeout (ms). ≤0 disables reaping.
    pub idle_reap_ms: i64,
    /// Cadence (ms) of the hub's live-refresh ticker.
    pub live_refresh_ms: u64,
    /// Flush window (ms) for server-side coalescing of streamed assistantDeltas.
    pub delta_flush_ms: u64,
}

pub fn load() -> Config {
    let port = env_parse("PANTOKEN_PORT", 8787);
    let data_dir = std::env::var("PANTOKEN_DATA_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(default_data_dir);
    let vapid_subject = std::env::var("PANTOKEN_VAPID_SUBJECT")
        .unwrap_or_else(|_| "mailto:pantoken@example.com".into());
    let host = std::env::var("PANTOKEN_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let token = std::env::var("PANTOKEN_TOKEN")
        .ok()
        .filter(|t| !t.is_empty());
    let debug = std::env::var("PANTOKEN_DEBUG")
        .map(|v| v != "0")
        .unwrap_or(true);
    let client_dist = std::env::var("PANTOKEN_CLIENT_DIST")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // Default: ../../client/dist relative to the crate root (server-rs/pantoken-server)
            // In dev, Vite serves the client and proxies here, so this path is only used
            // when the client has been built. The CARGO_MANIFEST_DIR points at
            // server-rs/pantoken-server, so ../../client/dist = the repo's client/dist.
            let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
            manifest_dir.join("../../client/dist")
        });
    let warm_cap = env_parse("PANTOKEN_WARM_CAP", 8);
    let idle_reap_ms = env_parse("PANTOKEN_IDLE_REAP_MS", 10 * 60 * 1000);
    let live_refresh_ms = env_parse("PANTOKEN_LIVE_REFRESH_MS", 1000);
    let delta_flush_ms = env_parse("PANTOKEN_DELTA_FLUSH_MS", 50);

    Config {
        port,
        data_dir,
        vapid_subject,
        host,
        token,
        debug,
        client_dist,
        warm_cap,
        idle_reap_ms,
        live_refresh_ms,
        delta_flush_ms,
    }
}

fn env_parse<T: std::str::FromStr>(var: &str, default: T) -> T {
    std::env::var(var)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Token check. None token = auth disabled. This is a plain string compare, not a
/// constant-time one: pantoken is single-user behind `tailscale serve`, so a timing
/// side-channel on the token isn't in the threat model.
pub fn token_ok(provided: Option<&str>, config: &Config) -> bool {
    config.token.is_none() || provided == config.token.as_deref()
}

/// Extract the app token from a request. Prefers `Authorization: Bearer <token>`,
/// falls back to a `?token=` query param.
pub fn token_from_request(auth_header: Option<&str>, query_token: Option<&str>) -> Option<String> {
    if let Some(auth) = auth_header {
        if let Some(rest) = auth.strip_prefix("Bearer ") {
            return Some(rest.trim().to_string());
        }
    }
    query_token.map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_ok_when_no_token_configured() {
        let cfg = Config {
            port: 8787,
            data_dir: PathBuf::from("/tmp"),
            vapid_subject: "mailto:test@test.com".into(),
            host: "127.0.0.1".into(),
            token: None,
            debug: true,
            client_dist: PathBuf::from("/tmp"),
            warm_cap: 8,
            idle_reap_ms: 600000,
            live_refresh_ms: 1000,
            delta_flush_ms: 50,
        };
        assert!(token_ok(None, &cfg));
        assert!(token_ok(Some("anything"), &cfg));
    }

    #[test]
    fn token_ok_with_exact_match() {
        let cfg = Config {
            token: Some("secret".into()),
            ..test_config()
        };
        assert!(token_ok(Some("secret"), &cfg));
        assert!(!token_ok(Some("wrong"), &cfg));
        assert!(!token_ok(None, &cfg));
    }

    #[test]
    fn token_from_request_prefers_bearer_header() {
        let token = token_from_request(Some("Bearer abc123"), Some("query456"));
        assert_eq!(token, Some("abc123".into()));
    }

    #[test]
    fn token_from_request_falls_back_to_query() {
        let token = token_from_request(None, Some("query456"));
        assert_eq!(token, Some("query456".into()));
    }

    #[test]
    fn token_from_request_returns_none_when_absent() {
        let token = token_from_request(None, None);
        assert_eq!(token, None);
    }

    // ── Ported from config.test.ts.bak ──────────────────────────

    #[test]
    fn empty_string_token_behaves_like_real_token() {
        // An empty env var would set token=""; it must NOT be treated as
        // "auth disabled" (which None means). Only None disables.
        let cfg = Config {
            token: Some("".into()),
            ..test_config()
        };
        assert!(token_ok(Some(""), &cfg));
        assert!(!token_ok(None, &cfg));
    }

    #[test]
    fn trims_whitespace_around_bearer_token() {
        let token = token_from_request(Some("Bearer   spaced   "), None);
        assert_eq!(token, Some("spaced".into()));
    }

    fn test_config() -> Config {
        Config {
            port: 8787,
            data_dir: PathBuf::from("/tmp"),
            vapid_subject: "mailto:test@test.com".into(),
            host: "127.0.0.1".into(),
            token: None,
            debug: true,
            client_dist: PathBuf::from("/tmp"),
            warm_cap: 8,
            idle_reap_ms: 600000,
            live_refresh_ms: 1000,
            delta_flush_ms: 50,
        }
    }

    #[test]
    fn migrate_renames_legacy_to_new_when_new_absent() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join(".local").join("state").join("pantoken");
        let new_dir = temp.path().join(".local").join("share").join("pantoken");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("worktrees.json"), "{}").unwrap();

        // Point both XDG vars at the temp root so default_data_dir and
        // legacy_data_dir resolve under it.
        unsafe {
            std::env::set_var("XDG_DATA_HOME", temp.path().join(".local").join("share"));
            std::env::set_var("XDG_STATE_HOME", temp.path().join(".local").join("state"));
            std::env::remove_var("PANTOKEN_DATA_DIR");
        }

        let cfg = Config {
            data_dir: new_dir.clone(),
            ..test_config()
        };
        migrate_legacy_data_dir(&cfg);

        assert!(new_dir.exists(), "new dir should exist after migration");
        assert!(
            new_dir.join("worktrees.json").exists(),
            "file should have moved"
        );
        assert!(!legacy.exists(), "legacy dir should be gone");

        unsafe {
            std::env::remove_var("XDG_DATA_HOME");
            std::env::remove_var("XDG_STATE_HOME");
        }
    }

    #[test]
    fn migrate_does_not_clobber_when_new_already_exists() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join(".local").join("state").join("pantoken");
        let new_dir = temp.path().join(".local").join("share").join("pantoken");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("old.txt"), "old").unwrap();
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(new_dir.join("new.txt"), "new").unwrap();

        unsafe {
            std::env::set_var("XDG_DATA_HOME", temp.path().join(".local").join("share"));
            std::env::set_var("XDG_STATE_HOME", temp.path().join(".local").join("state"));
            std::env::remove_var("PANTOKEN_DATA_DIR");
        }

        let cfg = Config {
            data_dir: new_dir.clone(),
            ..test_config()
        };
        migrate_legacy_data_dir(&cfg);

        // New dir wins — its file is intact, legacy untouched (left for manual cleanup).
        assert!(new_dir.join("new.txt").exists());
        assert!(!new_dir.join("old.txt").exists());
        assert!(legacy.exists(), "legacy should be left in place");

        unsafe {
            std::env::remove_var("XDG_DATA_HOME");
            std::env::remove_var("XDG_STATE_HOME");
        }
    }

    #[test]
    fn migrate_is_noop_when_pantoken_data_dir_set() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join(".local").join("state").join("pantoken");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("data.txt"), "data").unwrap();

        unsafe {
            std::env::set_var("XDG_STATE_HOME", temp.path().join(".local").join("state"));
            std::env::set_var("PANTOKEN_DATA_DIR", "/custom/explicit");
        }

        let cfg = Config {
            data_dir: PathBuf::from("/custom/explicit"),
            ..test_config()
        };
        migrate_legacy_data_dir(&cfg);

        // Legacy untouched because PANTOKEN_DATA_DIR was set.
        assert!(legacy.exists());
        assert!(legacy.join("data.txt").exists());

        unsafe {
            std::env::remove_var("XDG_STATE_HOME");
            std::env::remove_var("PANTOKEN_DATA_DIR");
        }
    }
}
