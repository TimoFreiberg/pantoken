//! Named validation: `codegen_embeds_daemon_version`.
//!
//! Asserts that `POLYTOKEN_DAEMON_TARGET_VERSION` is non-empty and parses as
//! semver (with optional prerelease). The codegen script's loud-fail-on-
//! unparseable-version is an implementation detail backstopped by this test:
//! if the script emitted garbage, the constant would be empty or unparseable
//! and this test would fail.
//!
//! Phase 0 only needs parse-validation, not comparison — the `>=` floor check
//! (with prerelease precedence) is a Phase 3 provisioning concern. Accordingly
//! this test uses a small manual `parse_semver` helper instead of adding a
//! `semver` or `regex` workspace dependency for parse-only validation.

use pantoken_daemon_types::POLYTOKEN_DAEMON_TARGET_VERSION;

/// Validate a version string is semver (with optional prerelease).
///
/// Mirrors the regex used in the codegen script:
/// `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$`
///
/// Returns `true` if the version parses as semver with optional prerelease.
fn parse_semver(version: &str) -> bool {
    // Split off the prerelease (if any) at the first '-'.
    let (core, prerelease) = match version.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (version, None),
    };

    // The core must be exactly three numeric components.
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return false;
    }

    // Each component must be numeric and non-negative, with no leading zeros
    // (except "0" itself), matching `(0|[1-9]\d*)`.
    for part in &parts {
        if part.is_empty() {
            return false;
        }
        if *part == "0" {
            continue;
        }
        if !part.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        if part.starts_with('0') {
            return false; // leading zero
        }
    }

    // If there's a prerelease, it must match `[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*`.
    if let Some(pre) = prerelease {
        if pre.is_empty() {
            return false;
        }
        for segment in pre.split('.') {
            if segment.is_empty() {
                return false;
            }
            if !segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                return false;
            }
        }
    }

    true
}

#[test]
fn codegen_embeds_daemon_version() {
    // AC.3: the constant must be non-empty.
    assert!(
        !POLYTOKEN_DAEMON_TARGET_VERSION.is_empty(),
        "POLYTOKEN_DAEMON_TARGET_VERSION must not be empty"
    );

    // AC.3: the constant must parse as semver.
    assert!(
        parse_semver(POLYTOKEN_DAEMON_TARGET_VERSION),
        "POLYTOKEN_DAEMON_TARGET_VERSION ({:?}) must parse as semver",
        POLYTOKEN_DAEMON_TARGET_VERSION
    );
}

#[test]
fn parse_semver_accepts_stable_versions() {
    assert!(parse_semver("1.0.0"));
    assert!(parse_semver("0.5.0"));
    assert!(parse_semver("10.20.30"));
}

#[test]
fn parse_semver_accepts_prerelease_versions() {
    assert!(parse_semver("0.5.0-unstable.9"));
    assert!(parse_semver("1.0.0-alpha"));
    assert!(parse_semver("1.0.0-alpha.beta.1"));
    assert!(parse_semver("1.0.0-rc.1"));
}

#[test]
fn parse_semver_rejects_invalid_versions() {
    assert!(!parse_semver(""));
    assert!(!parse_semver("1.0"));
    assert!(!parse_semver("1.0.0.0"));
    assert!(!parse_semver("1.0.0-")); // empty prerelease
    assert!(!parse_semver("01.0.0")); // leading zero
    assert!(!parse_semver("1.0.0-alpha!")); // invalid prerelease char
    assert!(!parse_semver("v1.0.0")); // prefix
    assert!(!parse_semver("1.0.x")); // non-numeric
}
