//! Persisted remote-host profiles for the desktop remote-connection UX.
//!
//! A [`RemoteProfile`] stores everything the desktop needs to launch the bridge
//! + SSH stdio proxy for a remote Pantoken runtime: the SSH destination, the
//! polytoken policy (require an existing install vs. offer to install), and
//! optional overrides for the remote root + server binary path.
//!
//! ## Security invariant
//!
//! The model MUST NEVER contain plaintext SSH passwords or private key
//! material. Credentials live in the system SSH agent / keychain /
//! `~/.ssh/config`. This is enforced structurally (no such fields exist on
//! the struct) and verified by `remote_profile_rejects_plaintext_secrets`,
//! which scans the serialized JSON for any field whose name looks like a
//! secret carrier (`password`, `key`, `secret`, `token`). Adding such a field
//! would break that test loudly.

#![allow(clippy::doc_lazy_continuation)]

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// How an SSH endpoint is used for execution. Missing values deserialize as host mode.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExecutionTargetProfile {
    #[serde(rename = "host")]
    #[default]
    Host,
    #[serde(rename = "dockerContainer")]
    DockerContainer {
        #[serde(rename = "containerName", alias = "container_name")]
        container_name: String,
        user: String,
        #[serde(rename = "workdir", default, skip_serializing_if = "Option::is_none")]
        workdir: Option<String>,
        #[serde(rename = "pantokenRoot", alias = "pantoken_root")]
        pantoken_root: String,
    },
}

/// Persisted hashes of explicitly acknowledged execution risks.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RiskAcknowledgements {
    #[serde(
        rename = "rootFingerprint",
        alias = "root_fingerprint",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub root_fingerprint: Option<String>,
    #[serde(
        rename = "ephemeralFingerprint",
        alias = "ephemeral_fingerprint",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ephemeral_fingerprint: Option<String>,
    #[serde(
        rename = "dockerSocketFingerprint",
        alias = "docker_socket_fingerprint",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub docker_socket_fingerprint: Option<String>,
}

/// A persisted remote-host profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProfile {
    /// Stable identity (UUID or slug). Not displayed.
    pub id: String,
    /// Display name ("Mac Mini", "Build Server").
    pub label: String,
    /// `user@host` or an SSH config alias. Relies on the system SSH agent /
    /// keychain / `~/.ssh/config` for credentials.
    #[serde(alias = "ssh_destination")]
    pub ssh_destination: String,
    /// SSH port; defaults to 22 when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Whether the remote runtime must already exist, or the desktop should
    /// offer to install it. Phase 2 only wires `RequireExisting`.
    #[serde(alias = "polytoken_policy", default)]
    pub polytoken_policy: PolytokenPolicy,
    /// Override for the remote runtime's data root (default
    /// `~/.local/share/pantoken`). Stored verbatim.
    #[serde(
        alias = "remote_root_override",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub remote_root_override: Option<String>,
    /// Override for the remote `pantoken-server` binary path (default
    /// `pantoken-server`, expected on the remote PATH).
    #[serde(
        alias = "server_path",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub server_path: Option<String>,
    /// XDG isolation mode for a Pantoken-managed polytoken. Defaults to
    /// `Isolated` — Pantoken-managed XDG roots under the remote root.
    #[serde(alias = "xdg_mode", default)]
    pub xdg_mode: XdgMode,
    #[serde(alias = "execution_target", default)]
    pub execution_target: ExecutionTargetProfile,
    #[serde(alias = "risk_acknowledgements", default)]
    pub risk_acknowledgements: RiskAcknowledgements,
}

/// Policy for the remote polytoken runtime install.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PolytokenPolicy {
    /// The remote runtime must already be reachable. Phase 2 default.
    #[default]
    RequireExisting,
    /// The desktop may offer to install / upgrade the remote runtime.
    /// Defined for Phase 3 (auto-provisioning); not wired in Phase 2.
    OfferInstall,
}

/// XDG isolation mode for a Pantoken-managed polytoken on the remote host.
///
/// Controls whether the polytoken daemon uses Pantoken-managed XDG roots
/// (under the remote root) or shares the user's existing polytoken XDG roots.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum XdgMode {
    /// Pantoken-managed XDG roots under the remote root. This is the safe
    /// default — never silently share production state.
    #[default]
    Isolated,
    /// User confirmed sharing existing polytoken XDG roots. No XDG override
    /// env vars are set; polytoken uses its default roots.
    Shared,
}

/// Field names that a plaintext secret carrier would plausibly use. The
/// serialized profile must contain none of these — credentials live in the
/// system SSH agent / keychain / `~/.ssh/config`, never in the profile JSON.
#[allow(dead_code)]
const SECRET_FIELD_NAMES: &[&str] = &["password", "key", "secret", "token"];

impl RemoteProfile {
    /// Validate the profile's required fields. Returns the first error, if any.
    ///
    /// - `label` and `ssh_destination` must be non-empty (after trimming).
    /// - `port`, if set, must be in 1..=65535.
    /// - `id` must be non-empty (after trimming).
    pub fn validate(&self) -> Result<(), RemoteProfileError> {
        if self.id.trim().is_empty() {
            return Err(RemoteProfileError::EmptyId);
        }
        if self.label.trim().is_empty() {
            return Err(RemoteProfileError::EmptyLabel);
        }
        if self.ssh_destination.trim().is_empty() {
            return Err(RemoteProfileError::EmptyDestination);
        }
        if let Some(port) = self.port {
            if port == 0 {
                return Err(RemoteProfileError::InvalidPort(port));
            }
        }
        match &self.execution_target {
            ExecutionTargetProfile::Host => {}
            ExecutionTargetProfile::DockerContainer {
                container_name,
                user,
                workdir,
                pantoken_root,
            } => {
                if container_name.trim().is_empty() {
                    return Err(RemoteProfileError::EmptyContainerName);
                }
                if !valid_docker_user(user) {
                    return Err(RemoteProfileError::InvalidContainerUser);
                }
                validate_absolute_path(pantoken_root)?;
                if let Some(path) = workdir {
                    validate_absolute_path(path)?;
                }
            }
        }
        if let Some(a) = [
            &self.risk_acknowledgements.root_fingerprint,
            &self.risk_acknowledgements.ephemeral_fingerprint,
            &self.risk_acknowledgements.docker_socket_fingerprint,
        ]
        .into_iter()
        .flatten()
        .find(|s| !valid_fingerprint(s))
        {
            return Err(RemoteProfileError::InvalidFingerprint(a.clone()));
        }
        Ok(())
    }

    /// Resolve the effective remote root (override or the documented default).
    pub fn remote_root(&self) -> &str {
        self.remote_root_override
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("~/.local/share/pantoken")
    }

    /// Resolve the effective remote server binary path (override or the
    /// documented default `pantoken-server`).
    pub fn server_path(&self) -> &str {
        self.server_path
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("pantoken-server")
    }

    /// Scan the serialized JSON for any field whose name looks like a plaintext
    /// secret carrier. Returns the first offending field name, if any.
    ///
    /// This is a belt-and-suspenders structural guard: the struct has no such
    /// fields, but if one is ever added this catches it before it ships.
    #[allow(dead_code)]
    pub fn find_secret_field(&self) -> Option<&'static str> {
        let json = serde_json::to_value(self).ok()?;
        scan_value_for_secret_fields(&json)
    }
}

/// Errors raised by [`RemoteProfile::validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteProfileError {
    /// `id` is empty.
    EmptyId,
    /// `label` is empty.
    EmptyLabel,
    /// `ssh_destination` is empty.
    EmptyDestination,
    /// `port` is 0 (or, by future extension, out of range).
    InvalidPort(u16),
    EmptyContainerName,
    InvalidContainerUser,
    InvalidPath(String),
    InvalidFingerprint(String),
}

impl std::fmt::Display for RemoteProfileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemoteProfileError::EmptyId => write!(f, "profile id must not be empty"),
            RemoteProfileError::EmptyLabel => write!(f, "profile label must not be empty"),
            RemoteProfileError::EmptyDestination => {
                write!(f, "ssh_destination must not be empty")
            }
            RemoteProfileError::InvalidPort(p) => {
                write!(f, "port {p} is invalid (must be 1..=65535)")
            }
            RemoteProfileError::EmptyContainerName => write!(f, "container name must not be empty"),
            RemoteProfileError::InvalidContainerUser => write!(f, "container user is invalid"),
            RemoteProfileError::InvalidPath(p) => write!(f, "unsafe absolute path: {p}"),
            RemoteProfileError::InvalidFingerprint(_) => {
                write!(f, "risk fingerprint must be lowercase SHA-256 hex")
            }
        }
    }
}

fn valid_docker_user(s: &str) -> bool {
    if s.is_empty()
        || s.chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '/')
    {
        return false;
    }
    if s.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    if let Some((u, g)) = s.split_once(':') {
        return !u.is_empty()
            && !g.is_empty()
            && u.chars().all(|c| c.is_ascii_digit())
            && g.chars().all(|c| c.is_ascii_digit());
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn validate_absolute_path(path: &str) -> Result<(), RemoteProfileError> {
    let p = Path::new(path);
    if !p.is_absolute()
        || path.is_empty()
        || path.chars().any(|c| c.is_control())
        || p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(RemoteProfileError::InvalidPath(path.to_owned()));
    }
    Ok(())
}

fn valid_fingerprint(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn encode_field(bytes: &mut Vec<u8>, value: &str) {
    bytes.extend_from_slice(value.len().to_string().as_bytes());
    bytes.push(b':');
    bytes.extend_from_slice(value.as_bytes());
}
fn fingerprint(fields: &[String]) -> String {
    let mut bytes = Vec::new();
    for field in fields {
        encode_field(&mut bytes, field);
    }
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn root_risk_fingerprint(
    schema_version: u16,
    profile_id: &str,
    container_name: &str,
    container_id: &str,
    requested_user: &str,
    uid: u64,
    gid: u64,
) -> String {
    fingerprint(&[
        schema_version.to_string(),
        profile_id.into(),
        container_name.into(),
        container_id.into(),
        requested_user.into(),
        uid.to_string(),
        gid.to_string(),
    ])
}

/// Ephemeral-data risk fingerprint.
///
/// Parameters mirror the canonical field order specified in the plan:
/// schema version, profile id, container name, container ID, root,
/// classification, mount destination, mount type, read/write mode,
/// and backing identity hash.
#[allow(clippy::too_many_arguments)]
pub fn ephemeral_risk_fingerprint(
    schema_version: u16,
    profile_id: &str,
    container_name: &str,
    container_id: &str,
    root: &str,
    classification: &str,
    mount_destination: &str,
    mount_type: &str,
    read_write: &str,
    backing_identity_hash: &str,
) -> String {
    fingerprint(&[
        schema_version.to_string(),
        profile_id.into(),
        container_name.into(),
        container_id.into(),
        root.into(),
        classification.into(),
        mount_destination.into(),
        mount_type.into(),
        read_write.into(),
        backing_identity_hash.into(),
    ])
}

/// Docker-socket risk fingerprint.
///
/// Covers the container identity + the socket mount's source and destination
/// paths, so the risk is invalidated when the container is replaced or the
/// socket mount changes.
pub fn socket_risk_fingerprint(
    schema_version: u16,
    profile_id: &str,
    container_name: &str,
    container_id: &str,
    socket_source: &str,
    socket_destination: &str,
) -> String {
    fingerprint(&[
        schema_version.to_string(),
        profile_id.into(),
        container_name.into(),
        container_id.into(),
        socket_source.into(),
        socket_destination.into(),
    ])
}

impl std::error::Error for RemoteProfileError {}

/// Recursively scan a JSON value for object keys matching
/// [`SECRET_FIELD_NAMES`] (case-insensitive).
#[allow(dead_code)]
fn scan_value_for_secret_fields(value: &serde_json::Value) -> Option<&'static str> {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                let lower = k.to_ascii_lowercase();
                if SECRET_FIELD_NAMES.iter().any(|s| *s == lower) {
                    return SECRET_FIELD_NAMES.iter().copied().find(|s| *s == lower);
                }
                if let Some(found) = scan_value_for_secret_fields(v) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(items) => items.iter().find_map(scan_value_for_secret_fields),
        _ => None,
    }
}

// ── Persistence ──────────────────────────────────────────────────────────

/// A collection of remote profiles, persisted as JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RemoteProfileStore {
    #[serde(default)]
    pub profiles: Vec<RemoteProfile>,
}

impl RemoteProfileStore {
    /// Load the profile collection from a JSON file. Returns an empty store
    /// if the file does not exist (a fresh install). Returns an error if the
    /// file exists but is unreadable / malformed.
    pub fn load(path: &Path) -> std::io::Result<Self> {
        match std::fs::read(path) {
            Ok(bytes) => {
                if bytes.is_empty() {
                    return Ok(Self::default());
                }
                serde_json::from_slice(&bytes).map_err(|e| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("remote-profiles.json: {e}"),
                    )
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e),
        }
    }

    /// Atomically write the profile collection to a JSON file: serialize,
    /// write to a temp file next to the target, then rename over the target.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("serialize: {e}"))
        })?;
        atomic_write(path, &bytes)
    }
}

/// Atomic file write: write to `<path>.tmp.<pid>` then rename over the target.
/// Creates parent directories as needed.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `remote_profile_serialization_roundtrip` (AC.2)
    //! - `remote_profile_rejects_plaintext_secrets` (AC.2)
    //! - `remote_profile_validation` (AC.2)

    use super::*;

    fn sample_profile() -> RemoteProfile {
        RemoteProfile {
            id: "mac-mini".into(),
            label: "Mac Mini".into(),
            ssh_destination: "timo@mac-mini.local".into(),
            port: Some(2222),
            polytoken_policy: PolytokenPolicy::RequireExisting,
            remote_root_override: Some("/srv/pantoken".into()),
            server_path: Some("/usr/local/bin/pantoken-server".into()),
            xdg_mode: XdgMode::default(),
            execution_target: ExecutionTargetProfile::default(),
            risk_acknowledgements: RiskAcknowledgements::default(),
        }
    }

    #[test]
    fn remote_profile_serialization_roundtrip() {
        let profile = sample_profile();
        let json = serde_json::to_string(&profile).expect("serialize");
        let back: RemoteProfile = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(back.id, profile.id);
        assert_eq!(back.label, profile.label);
        assert_eq!(back.ssh_destination, profile.ssh_destination);
        assert_eq!(back.port, profile.port);
        assert_eq!(back.polytoken_policy, profile.polytoken_policy);
        assert_eq!(back.remote_root_override, profile.remote_root_override);
        assert_eq!(back.server_path, profile.server_path);

        // Also round-trips through a serde_json::Value and verify the canonical
        // command shape. Legacy snake_case names are accepted on input but are
        // never emitted when profiles are persisted or returned to Tauri.
        let as_value = serde_json::to_value(&profile).expect("to value");
        let object = as_value.as_object().expect("profile object");
        for key in [
            "sshDestination",
            "polytokenPolicy",
            "remoteRootOverride",
            "serverPath",
            "xdgMode",
            "executionTarget",
            "riskAcknowledgements",
        ] {
            assert!(object.contains_key(key), "missing canonical key {key}");
        }
        for key in [
            "ssh_destination",
            "polytoken_policy",
            "remote_root_override",
            "server_path",
            "xdg_mode",
            "execution_target",
            "risk_acknowledgements",
        ] {
            assert!(!object.contains_key(key), "legacy key emitted: {key}");
        }
        let from_value: RemoteProfile = serde_json::from_value(as_value).expect("from value");
        assert_eq!(from_value.id, profile.id);
        assert_eq!(from_value.label, profile.label);
    }

    #[test]
    fn remote_profile_rejects_plaintext_secrets() {
        // The struct as-defined has no secret-named fields.
        let profile = sample_profile();
        assert!(
            profile.find_secret_field().is_none(),
            "a profile must not serialize any field named password/key/secret/token"
        );

        // Defense-in-depth: simulate adding a `password` field via a raw JSON
        // value and verify the scanner catches it.
        let mut raw = serde_json::to_value(&profile).expect("to value");
        if let serde_json::Value::Object(ref mut map) = raw {
            map.insert(
                "password".into(),
                serde_json::Value::String("hunter2".into()),
            );
        }
        assert_eq!(
            scan_value_for_secret_fields(&raw),
            Some("password"),
            "scanner must flag an injected password field"
        );

        // Nested secrets (e.g. a sub-object) must also be caught.
        let mut nested = serde_json::to_value(&profile).expect("to value");
        if let serde_json::Value::Object(ref mut map) = nested {
            map.insert("credentials".into(), serde_json::json!({"token": "abc123"}));
        }
        assert_eq!(
            scan_value_for_secret_fields(&nested),
            Some("token"),
            "scanner must flag nested secret fields"
        );
    }

    #[test]
    fn remote_profile_validation() {
        assert!(sample_profile().validate().is_ok());

        let mut profile = sample_profile();
        profile.id = "   ".into();
        assert_eq!(profile.validate(), Err(RemoteProfileError::EmptyId));

        let mut profile = sample_profile();
        profile.label.clear();
        assert_eq!(profile.validate(), Err(RemoteProfileError::EmptyLabel));

        let mut profile = sample_profile();
        profile.ssh_destination.clear();
        assert_eq!(
            profile.validate(),
            Err(RemoteProfileError::EmptyDestination)
        );

        let mut profile = sample_profile();
        profile.port = Some(0);
        assert_eq!(profile.validate(), Err(RemoteProfileError::InvalidPort(0)));

        let mut profile = sample_profile();
        profile.port = Some(65535);
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn remote_profile_host_mode_migration() {
        let legacy = serde_json::json!({
            "id": "legacy",
            "label": "Legacy host",
            "ssh_destination": "work-server",
            "polytoken_policy": "requireExisting",
            "xdg_mode": "isolated"
        });
        let profile: RemoteProfile = serde_json::from_value(legacy).expect("legacy profile");
        assert_eq!(profile.execution_target, ExecutionTargetProfile::Host);
        assert_eq!(
            profile.risk_acknowledgements,
            RiskAcknowledgements::default()
        );
    }

    #[test]
    fn remote_profile_camel_case_command_payload() {
        let payload = serde_json::json!({
            "id": "docker-1",
            "label": "Work API",
            "sshDestination": "dev@server",
            "port": 2222,
            "polytokenPolicy": "offerInstall",
            "remoteRootOverride": "/srv/pantoken",
            "serverPath": "/opt/pantoken-server",
            "xdgMode": "shared",
            "executionTarget": {
                "kind": "dockerContainer",
                "containerName": "work-api",
                "user": "1000:1000",
                "workdir": "/workspace/api",
                "pantokenRoot": "/var/lib/pantoken"
            },
            "riskAcknowledgements": {
                "rootFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "ephemeralFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "dockerSocketFingerprint": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            }
        });
        let profile: RemoteProfile = serde_json::from_value(payload).expect("camelCase profile");
        assert_eq!(profile.ssh_destination, "dev@server");
        assert_eq!(profile.polytoken_policy, PolytokenPolicy::OfferInstall);
        assert_eq!(
            profile.execution_target,
            ExecutionTargetProfile::DockerContainer {
                container_name: "work-api".into(),
                user: "1000:1000".into(),
                workdir: Some("/workspace/api".into()),
                pantoken_root: "/var/lib/pantoken".into(),
            }
        );
        assert_eq!(
            profile.risk_acknowledgements.root_fingerprint.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn remote_profile_execution_target_roundtrip() {
        let mut profile = sample_profile();
        profile.execution_target = ExecutionTargetProfile::DockerContainer {
            container_name: "work-api".into(),
            user: "1000:1000".into(),
            workdir: Some("/workspace/api".into()),
            pantoken_root: "/var/lib/pantoken".into(),
        };
        let value = serde_json::to_value(&profile).expect("serialize");
        let target = value.get("executionTarget").expect("target");
        assert_eq!(
            target.get("containerName").and_then(|v| v.as_str()),
            Some("work-api")
        );
        assert_eq!(
            target.get("pantokenRoot").and_then(|v| v.as_str()),
            Some("/var/lib/pantoken")
        );
        assert!(target.get("container_name").is_none());
        let decoded: RemoteProfile = serde_json::from_value(value).expect("deserialize");
        assert_eq!(decoded.execution_target, profile.execution_target);
        assert!(decoded.validate().is_ok());
    }

    #[test]
    fn docker_profile_validation_rejects_unsafe_values() {
        for target in [
            ExecutionTargetProfile::DockerContainer {
                container_name: "".into(),
                user: "1000".into(),
                workdir: None,
                pantoken_root: "/data".into(),
            },
            ExecutionTargetProfile::DockerContainer {
                container_name: "api".into(),
                user: "1000:bad".into(),
                workdir: None,
                pantoken_root: "/data".into(),
            },
            ExecutionTargetProfile::DockerContainer {
                container_name: "api".into(),
                user: "worker".into(),
                workdir: Some("relative".into()),
                pantoken_root: "/data".into(),
            },
            ExecutionTargetProfile::DockerContainer {
                container_name: "api".into(),
                user: "worker".into(),
                workdir: None,
                pantoken_root: "/data/../escape".into(),
            },
        ] {
            let mut profile = sample_profile();
            profile.execution_target = target;
            assert!(profile.validate().is_err());
        }
    }

    #[test]
    fn risk_fingerprint_fixed_vectors_and_invalidation() {
        let root = root_risk_fingerprint(1, "profile-1", "work-api", "sha256:012345", "0:0", 0, 0);
        assert_eq!(
            root,
            "7eb85b106802f68b8ef9560b3284786a967a86a37d38c8c1ca8b4b698bd08b27"
        );
        assert_ne!(
            root,
            root_risk_fingerprint(1, "profile-1", "work-api", "sha256:999999", "0:0", 0, 0)
        );

        let ephemeral = ephemeral_risk_fingerprint(
            1,
            "profile-1",
            "work-api",
            "sha256:012345",
            "/var/lib/pantoken",
            "writableLayer",
            "<no-covering-mount>",
            "writableLayer",
            "readWrite",
            "<writable-layer>",
        );
        assert_eq!(
            ephemeral,
            "53ba98c59c3553e5a07bfb761a153df95c4770da4cf2925a28a0d3d05a7e1580"
        );
        assert_ne!(
            ephemeral,
            ephemeral_risk_fingerprint(
                1,
                "profile-1",
                "work-api",
                "sha256:012345",
                "/different-root",
                "writableLayer",
                "<no-covering-mount>",
                "writableLayer",
                "readWrite",
                "<writable-layer>",
            )
        );
    }

    #[test]
    fn remote_profile_defaults_resolve() {
        let mut profile = sample_profile();
        profile.remote_root_override = None;
        profile.server_path = None;
        assert_eq!(profile.remote_root(), "~/.local/share/pantoken");
        assert_eq!(profile.server_path(), "pantoken-server");

        profile.remote_root_override = Some("/srv/p".into());
        profile.server_path = Some("/x/pantoken-server".into());
        assert_eq!(profile.remote_root(), "/srv/p");
        assert_eq!(profile.server_path(), "/x/pantoken-server");

        profile.remote_root_override = Some(String::new());
        profile.server_path = Some(String::new());
        assert_eq!(profile.remote_root(), "~/.local/share/pantoken");
        assert_eq!(profile.server_path(), "pantoken-server");
    }

    #[test]
    fn remote_profile_store_load_save_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("remote-profiles.json");

        // Loading a missing file yields an empty store.
        let store = RemoteProfileStore::load(&path).expect("load missing");
        assert!(store.profiles.is_empty());

        // Save + reload.
        let store = RemoteProfileStore {
            profiles: vec![sample_profile()],
        };
        store.save(&path).expect("save");

        let reloaded = RemoteProfileStore::load(&path).expect("reload");
        assert_eq!(reloaded.profiles.len(), 1);
        assert_eq!(reloaded.profiles[0].id, "mac-mini");
        assert_eq!(reloaded.profiles[0].label, "Mac Mini");

        // Empty file → empty store (defensive).
        std::fs::write(&path, b"").expect("truncate");
        assert!(RemoteProfileStore::load(&path)
            .expect("load empty")
            .profiles
            .is_empty());
    }

    #[test]
    fn remote_profile_store_legacy_docker_roundtrip_writes_camel_case() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("remote-profiles.json");
        let legacy = serde_json::json!({
            "profiles": [{
                "id": "legacy-docker",
                "label": "Legacy Docker",
                "ssh_destination": "dev@server",
                "polytoken_policy": "requireExisting",
                "execution_target": {
                    "kind": "dockerContainer",
                    "container_name": "work-api",
                    "user": "worker",
                    "workdir": "/workspace",
                    "pantoken_root": "/var/lib/pantoken"
                },
                "risk_acknowledgements": {
                    "root_fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "ephemeral_fingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "docker_socket_fingerprint": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                }
            }]
        });
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).expect("write legacy");
        let store = RemoteProfileStore::load(&path).expect("load legacy");
        let profile = &store.profiles[0];
        assert_eq!(
            profile.execution_target,
            ExecutionTargetProfile::DockerContainer {
                container_name: "work-api".into(),
                user: "worker".into(),
                workdir: Some("/workspace".into()),
                pantoken_root: "/var/lib/pantoken".into(),
            }
        );
        assert_eq!(
            profile
                .risk_acknowledgements
                .ephemeral_fingerprint
                .as_deref(),
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        store.save(&path).expect("save canonical");
        let saved = std::fs::read_to_string(&path).expect("read canonical");
        for key in [
            "containerName",
            "pantokenRoot",
            "rootFingerprint",
            "ephemeralFingerprint",
            "dockerSocketFingerprint",
        ] {
            assert!(saved.contains(key), "missing canonical key {key}");
        }
        for key in [
            "container_name",
            "pantoken_root",
            "root_fingerprint",
            "ephemeral_fingerprint",
            "docker_socket_fingerprint",
        ] {
            assert!(!saved.contains(key), "legacy key emitted: {key}");
        }
    }

    #[test]
    fn remote_profile_store_save_creates_parent_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested/deep/remote-profiles.json");
        let store = RemoteProfileStore {
            profiles: vec![sample_profile()],
        };
        store.save(&path).expect("save with mkdir -p");
        assert!(path.is_file());
    }

    #[test]
    fn polytoken_policy_serde_camel_case() {
        // RequireExisting (default) serializes to camelCase.
        let p = PolytokenPolicy::RequireExisting;
        let v = serde_json::to_value(p).expect("serialize");
        assert_eq!(v, serde_json::json!("requireExisting"));
        let back: PolytokenPolicy = serde_json::from_value(v).expect("deserialize");
        assert_eq!(back, PolytokenPolicy::RequireExisting);

        // OfferInstall.
        let p = PolytokenPolicy::OfferInstall;
        let v = serde_json::to_value(p).expect("serialize");
        assert_eq!(v, serde_json::json!("offerInstall"));
        let back: PolytokenPolicy = serde_json::from_value(v).expect("deserialize");
        assert_eq!(back, PolytokenPolicy::OfferInstall);

        // Default is RequireExisting.
        assert_eq!(PolytokenPolicy::default(), PolytokenPolicy::RequireExisting);
    }

    #[test]
    fn socket_risk_fingerprint_fixed_vector_and_invalidation() {
        let fp = socket_risk_fingerprint(
            1,
            "profile-1",
            "work-api",
            "sha256:012345",
            "/var/run/docker.sock",
            "/var/run/docker.sock",
        );
        // Must be a 64-char lowercase hex string.
        assert_eq!(fp.len(), 64);
        assert!(fp
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));

        // Invalidated by a different container ID.
        assert_ne!(
            fp,
            socket_risk_fingerprint(
                1,
                "profile-1",
                "work-api",
                "sha256:999999",
                "/var/run/docker.sock",
                "/var/run/docker.sock",
            )
        );

        // Invalidated by a different socket source.
        assert_ne!(
            fp,
            socket_risk_fingerprint(
                1,
                "profile-1",
                "work-api",
                "sha256:012345",
                "/custom/docker.sock",
                "/var/run/docker.sock",
            )
        );
    }

    #[test]
    fn docker_socket_fingerprint_validated_like_other_risks() {
        let mut profile = sample_profile();
        profile.risk_acknowledgements.docker_socket_fingerprint = Some("not-a-valid-hash".into());
        assert!(profile.validate().is_err());

        // A valid 64-char lowercase hex is accepted.
        profile.risk_acknowledgements.docker_socket_fingerprint = Some("a".repeat(64));
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn docker_socket_fingerprint_roundtrip() {
        let mut profile = sample_profile();
        profile.risk_acknowledgements.docker_socket_fingerprint =
            Some("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789".into());
        let json = serde_json::to_string(&profile).unwrap();
        assert!(
            json.contains("dockerSocketFingerprint"),
            "JSON should contain the socket fingerprint field"
        );
        let back: RemoteProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.risk_acknowledgements
                .docker_socket_fingerprint
                .as_deref(),
            Some("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789")
        );
    }
}
