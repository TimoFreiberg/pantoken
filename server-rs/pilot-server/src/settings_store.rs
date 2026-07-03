//! Pilot-local settings persisted across restarts. Distinct from the daemon's global
//! config (auth.json + the daemon's settings, reached through the driver): these are
//! pilot's OWN knobs, stored as a small JSON file in the data dir alongside the VAPID
//! key / archive index. Currently just the login-shell override; structured as an object
//! so future pilot-local settings slot in without a new store.
//!
//! Port of `server/src/settings-store.ts`.

use std::fs;
use std::path::Path;

use serde::Deserialize;

use pilot_protocol::wire::PilotSettings;

fn settings_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("pilot-settings.json")
}

/// Read pilot-local settings, layering persisted values over defaults. Never throws —
/// a missing file is just defaults; a corrupt file logs a warning and falls back
/// (house rule: surface, don't silently lose, but don't brick startup over a bad
/// settings file either).
pub fn read_pilot_settings(data_dir: &Path) -> PilotSettings {
    let path = settings_path(data_dir);
    if !path.exists() {
        return PilotSettings::default();
    }
    match fs::read_to_string(&path) {
        Ok(raw) => {
            match serde_json::from_str::<PartialSettings>(&raw) {
                Ok(partial) => {
                    let defaults = PilotSettings::default();
                    PilotSettings {
                        login_shell: partial.login_shell.or(defaults.login_shell),
                        background_model: partial.background_model.or(defaults.background_model),
                        enabled_extensions: partial.enabled_extensions.or(defaults.enabled_extensions),
                    }
                }
                Err(e) => {
                    eprintln!("[settings] failed to parse {}: using defaults — {e}", path.display());
                    PilotSettings::default()
                }
            }
        }
        Err(e) => {
            eprintln!("[settings] failed to read {}: using defaults — {e}", path.display());
            PilotSettings::default()
        }
    }
}

/// Merge a patch into persisted settings and write it back. Returns the new full
/// settings so callers can broadcast the authoritative value.
pub fn write_pilot_settings(data_dir: &Path, patch: &PilotSettings) -> PilotSettings {
    let current = read_pilot_settings(data_dir);
    let next = PilotSettings {
        login_shell: patch.login_shell.clone().or(current.login_shell),
        background_model: patch.background_model.clone().or(current.background_model),
        enabled_extensions: patch.enabled_extensions.clone().or(current.enabled_extensions),
    };
    fs::create_dir_all(data_dir).ok();
    let json = serde_json::to_string_pretty(&next).unwrap_or_else(|_| "{}".into());
    let path = settings_path(data_dir);
    let _ = fs::write(&path, format!("{json}\n"));
    next
}

/// A partial view of PilotSettings for merge-patching — all fields optional.
#[derive(Debug, Clone, Deserialize)]
struct PartialSettings {
    #[serde(rename = "loginShell", default)]
    login_shell: Option<String>,
    #[serde(rename = "backgroundModel", default)]
    background_model: Option<String>,
    #[serde(rename = "enabledExtensions", default)]
    enabled_extensions: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn read_returns_defaults_when_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let settings = read_pilot_settings(dir.path());
        assert!(settings.login_shell.is_none());
        assert!(settings.background_model.is_none());
    }

    #[test]
    fn read_returns_defaults_on_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(settings_path(dir.path()), "not json {{{").unwrap();
        let settings = read_pilot_settings(dir.path());
        assert!(settings.login_shell.is_none());
        assert!(settings.background_model.is_none());
    }

    #[test]
    fn write_then_read_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let patch = PilotSettings {
            login_shell: Some("/bin/zsh".into()),
            background_model: None,
            enabled_extensions: None,
        };
        let written = write_pilot_settings(dir.path(), &patch);
        assert_eq!(written.login_shell, Some("/bin/zsh".into()));

        let read = read_pilot_settings(dir.path());
        assert_eq!(read.login_shell, Some("/bin/zsh".into()));
        assert!(read.background_model.is_none());
    }

    #[test]
    fn write_merges_over_existing() {
        let dir = tempfile::tempdir().unwrap();
        // First write: set login shell
        write_pilot_settings(
            dir.path(),
            &PilotSettings {
                login_shell: Some("/bin/zsh".into()),
                background_model: None,
                enabled_extensions: None,
            },
        );
        // Second write: set background model only — login shell should persist
        let next = write_pilot_settings(
            dir.path(),
            &PilotSettings {
                login_shell: None,
                background_model: Some("sonnet".into()),
                enabled_extensions: None,
            },
        );
        assert_eq!(next.login_shell, Some("/bin/zsh".into()));
        assert_eq!(next.background_model, Some("sonnet".into()));
    }
}
