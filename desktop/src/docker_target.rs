//! Pure Docker-target discovery, validation, and command policy.
//!
//! Docker is reached only through one-shot commands on the SSH host. Target
//! operations use a full container ID pinned for one connection attempt.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

pub const CONTAINER_LIST_FORMAT: &str = r#"{{json .}}"#;

pub fn posix_quote(word: &str) -> String {
    if !word.is_empty()
        && word.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_' | '~' | ':' | '=')
        })
    {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

pub fn shell_join(words: &[String]) -> String {
    words
        .iter()
        .map(|word| posix_quote(word))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn normalize_absolute_path(value: &str) -> Result<String, DockerTargetError> {
    if value.is_empty() || value.chars().any(char::is_control) || !value.starts_with('/') {
        return Err(DockerTargetError::UnsafePath);
    }
    let mut parts = Vec::new();
    for component in Path::new(value).components() {
        match component {
            Component::RootDir => {}
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => {
                return Err(DockerTargetError::UnsafePath)
            }
        }
    }
    Ok(if parts.is_empty() {
        "/".into()
    } else {
        format!("/{}", parts.join("/"))
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DockerTargetError {
    UnsafePath,
    MalformedList { line: usize, reason: String },
    ContainerNotFound,
    AmbiguousContainer,
    ContainerUnavailable(String),
    MalformedInspect,
    ReadOnlyMount,
}

impl std::fmt::Display for DockerTargetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsafePath => write!(f, "path must be a safe absolute POSIX path"),
            Self::MalformedList { line, reason } => {
                write!(
                    f,
                    "Docker returned malformed container-list output at record {line}: {reason}"
                )
            }
            Self::ContainerNotFound => write!(f, "container was not found by exact name"),
            Self::AmbiguousContainer => {
                write!(f, "multiple containers had the exact requested name")
            }
            Self::ContainerUnavailable(state) => write!(f, "container is not running ({state})"),
            Self::MalformedInspect => write!(f, "Docker returned malformed inspect output"),
            Self::ReadOnlyMount => write!(
                f,
                "the deepest mount covering the Pantoken root is read-only"
            ),
        }
    }
}

impl std::error::Error for DockerTargetError {}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct ContainerListRecord {
    /// Docker emits `ID`; older fixtures used the serde-derived `Id` spelling.
    #[serde(rename = "ID", alias = "Id")]
    pub id: String,
    pub names: String,
    pub image: String,
    pub state: String,
    pub status: String,
    /// Docker emits labels as `key=value,key2=value2`; retain support for the
    /// map-shaped representation used by older fixtures and persisted tests.
    #[serde(default, deserialize_with = "deserialize_labels")]
    pub labels: std::collections::HashMap<String, String>,
}

fn deserialize_labels<'de, D>(
    deserializer: D,
) -> Result<std::collections::HashMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Labels {
        Map(std::collections::HashMap<String, String>),
        Text(String),
    }

    let labels =
        Option::<Labels>::deserialize(deserializer)?.unwrap_or(Labels::Text(String::new()));
    Ok(match labels {
        Labels::Map(map) => map,
        Labels::Text(text) => text
            .split(',')
            .filter_map(|entry| entry.split_once('='))
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
            .collect(),
    })
}

/// Extract Compose project + service from a container's label map.
pub fn compose_metadata(
    labels: &std::collections::HashMap<String, String>,
) -> (Option<String>, Option<String>) {
    let project = labels
        .get("com.docker.compose.project")
        .cloned()
        .filter(|s| !s.is_empty());
    let service = labels
        .get("com.docker.compose.service")
        .cloned()
        .filter(|s| !s.is_empty());
    (project, service)
}

/// Find a Docker socket mount: a bind mount whose source or destination ends
/// in `docker.sock`. Returns the mount if found, so the caller can compute a
/// fingerprint for risk acknowledgement.
pub fn find_socket_mount(mounts: &[DockerMount]) -> Option<&DockerMount> {
    mounts.iter().find(|m| {
        m.mount_type == "bind"
            && (m.source.ends_with("docker.sock") || m.destination.ends_with("docker.sock"))
    })
}

pub fn parse_container_list(stdout: &str) -> Result<Vec<ContainerListRecord>, DockerTargetError> {
    stdout
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(index, line)| {
            serde_json::from_str(line).map_err(|error| DockerTargetError::MalformedList {
                line: index + 1,
                reason: error.to_string().chars().take(120).collect(),
            })
        })
        .collect()
}

pub fn resolve_exact_running(
    records: &[ContainerListRecord],
    exact_name: &str,
) -> Result<ContainerListRecord, DockerTargetError> {
    let matches: Vec<_> = records
        .iter()
        .filter(|record| record.names == exact_name)
        .collect();
    let record = match matches.as_slice() {
        [] => return Err(DockerTargetError::ContainerNotFound),
        [record] => (*record).clone(),
        _ => return Err(DockerTargetError::AmbiguousContainer),
    };
    if !record.state.eq_ignore_ascii_case("running") {
        return Err(DockerTargetError::ContainerUnavailable(record.state));
    }
    Ok(record)
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct DockerMount {
    #[serde(rename = "Type")]
    pub mount_type: String,
    pub name: Option<String>,
    pub source: String,
    pub destination: String,
    pub mode: String,
    #[serde(rename = "RW")]
    pub read_write: bool,
}

/// Docker inspect data. Fields like `name`, `image`, and `config` are parsed
/// from the inspect JSON for diagnostics and future use but are not all read
/// in the current logic paths.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct DockerInspect {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: InspectState,
    pub config: InspectConfig,
    pub mounts: Vec<DockerMount>,
    /// Platform OS/arch (e.g. "linux"/"amd64"). Present on daemon-side inspect
    /// output; absent on some Docker versions.
    #[serde(default)]
    pub platform: Option<DockerPlatform>,
}

/// Platform info from `docker container inspect`.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct DockerPlatform {
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default, rename = "Architecture")]
    pub architecture: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct InspectState {
    pub status: String,
    pub running: bool,
    pub paused: bool,
    pub restarting: bool,
    pub dead: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct InspectConfig {
    pub user: String,
    pub working_dir: String,
    pub image: String,
}

pub fn parse_inspect(stdout: &str) -> Result<DockerInspect, DockerTargetError> {
    let mut records: Vec<DockerInspect> =
        serde_json::from_str(stdout).map_err(|_| DockerTargetError::MalformedInspect)?;
    if records.len() != 1 {
        return Err(DockerTargetError::MalformedInspect);
    }
    Ok(records.remove(0))
}

fn path_covers(destination: &str, path: &str) -> bool {
    destination == "/"
        || path == destination
        || path
            .strip_prefix(destination)
            .is_some_and(|rest| rest.starts_with('/'))
}

pub fn deepest_covering_mount<'a>(
    path: &str,
    mounts: &'a [DockerMount],
) -> Option<&'a DockerMount> {
    mounts
        .iter()
        .filter(|mount| path_covers(mount.destination.trim_end_matches('/'), path))
        .max_by_key(|mount| mount.destination.len())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersistenceClassification {
    PersistentBind,
    PersistentVolume,
    EphemeralTmpfs,
    EphemeralWritableLayer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistenceFacts {
    pub classification: PersistenceClassification,
    pub mount_destination: String,
    pub mount_type: String,
    pub read_write: String,
    pub backing_identity_hash: String,
}

fn backing_hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn persistence_facts(
    root: &str,
    mounts: &[DockerMount],
) -> Result<PersistenceFacts, DockerTargetError> {
    let root = normalize_absolute_path(root)?;
    let Some(mount) = deepest_covering_mount(&root, mounts) else {
        return Ok(PersistenceFacts {
            classification: PersistenceClassification::EphemeralWritableLayer,
            mount_destination: "<no-covering-mount>".into(),
            mount_type: "writableLayer".into(),
            read_write: "readWrite".into(),
            backing_identity_hash: "<writable-layer>".into(),
        });
    };
    if !mount.read_write {
        return Err(DockerTargetError::ReadOnlyMount);
    }
    let classification = match mount.mount_type.as_str() {
        "bind" => PersistenceClassification::PersistentBind,
        "volume" => PersistenceClassification::PersistentVolume,
        "tmpfs" => PersistenceClassification::EphemeralTmpfs,
        _ => PersistenceClassification::EphemeralWritableLayer,
    };
    let backing = match classification {
        PersistenceClassification::EphemeralTmpfs => "<tmpfs>".into(),
        PersistenceClassification::EphemeralWritableLayer => "<writable-layer>".into(),
        PersistenceClassification::PersistentVolume => {
            backing_hash(mount.name.as_deref().unwrap_or(&mount.source))
        }
        PersistenceClassification::PersistentBind => backing_hash(&mount.source),
    };
    Ok(PersistenceFacts {
        classification,
        mount_destination: normalize_absolute_path(&mount.destination)?,
        mount_type: mount.mount_type.clone(),
        read_write: "readWrite".into(),
        backing_identity_hash: backing,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDockerTarget {
    pub configured_name: String,
    pub container_id: String,
    pub user: String,
    pub workdir: Option<String>,
    pub pantoken_root: String,
    pub env: Vec<(String, String)>,
}

impl ResolvedDockerTarget {
    fn exec_prefix(&self) -> Vec<String> {
        let mut words = vec![
            "docker".into(),
            "exec".into(),
            "-i".into(),
            "--user".into(),
            self.user.clone(),
        ];
        if let Some(workdir) = &self.workdir {
            words.extend(["--workdir".into(), workdir.clone()]);
        }
        for (key, value) in &self.env {
            words.extend(["--env".into(), format!("{key}={value}")]);
        }
        words.push(self.container_id.clone());
        words
    }

    pub fn command_words(&self, script: &str) -> Vec<String> {
        let mut words = self.exec_prefix();
        words.extend(["sh".into(), "-c".into(), script.into()]);
        words
    }

    pub fn upload_words(&self, destination: &str) -> Result<Vec<String>, DockerTargetError> {
        let destination = normalize_absolute_path(destination)?;
        let mut words = self.exec_prefix();
        words.extend([
            "sh".into(),
            "-c".into(),
            "cat > \"$1\"".into(),
            "sh".into(),
            destination,
        ]);
        Ok(words)
    }

    pub fn proxy_words(&self, server_path: &str) -> Result<Vec<String>, DockerTargetError> {
        let server_path = normalize_absolute_path(server_path)?;
        let mut words = self.exec_prefix();
        words.push(server_path);
        Ok(words)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(name: &str, state: &str) -> ContainerListRecord {
        ContainerListRecord {
            id: format!("id-{name}"),
            names: name.into(),
            image: "image:latest".into(),
            state: state.into(),
            status: state.into(),
            labels: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn docker_list_parser_accepts_real_id_and_label_output() {
        let stdout = r#"{"ID":"abc123","Names":"work-api-dev","Image":"node:20-alpine","State":"running","Status":"Up 2 hours","Labels":"com.docker.compose.project=work-api,com.docker.compose.service=api"}
{"ID":"def456","Names":"postgres-dev","Image":"postgres:16","State":"exited","Status":"Exited 0","Labels":""}"#;
        let records = parse_container_list(stdout).unwrap();
        assert_eq!(records[0].id, "abc123");
        assert_eq!(
            records[0].labels.get("com.docker.compose.project"),
            Some(&"work-api".to_string())
        );
        assert_eq!(
            compose_metadata(&records[0].labels),
            (Some("work-api".into()), Some("api".into()))
        );
        assert!(records[1].labels.is_empty());
    }

    #[test]
    fn docker_list_parser_retains_map_fixture_compatibility() {
        let stdout = r#"{"Id":"abc123","Names":"api","Image":"node","State":"running","Status":"Up","Labels":{"com.docker.compose.project":"legacy","com.docker.compose.service":"api"}}"#;
        let records = parse_container_list(stdout).unwrap();
        assert_eq!(records[0].id, "abc123");
        assert_eq!(
            compose_metadata(&records[0].labels),
            (Some("legacy".into()), Some("api".into()))
        );
    }

    #[test]
    fn docker_exact_name_resolution_and_substring_names_do_not_match() {
        let records = vec![record("api", "running"), record("api-old", "running")];
        assert_eq!(resolve_exact_running(&records, "api").unwrap().id, "id-api");
        assert!(matches!(
            resolve_exact_running(&records, "ap"),
            Err(DockerTargetError::ContainerNotFound)
        ));
    }

    #[test]
    fn docker_running_only_matrix() {
        for state in ["exited", "paused", "restarting", "dead", "removing"] {
            assert!(matches!(
                resolve_exact_running(&[record("api", state)], "api"),
                Err(DockerTargetError::ContainerUnavailable(_))
            ));
        }
    }

    #[test]
    fn docker_mount_coverage_component_boundary_and_deepest() {
        let mounts = vec![
            DockerMount {
                mount_type: "volume".into(),
                name: Some("data".into()),
                source: "/var/lib/docker/volumes/data".into(),
                destination: "/data".into(),
                mode: "rw".into(),
                read_write: true,
            },
            DockerMount {
                mount_type: "bind".into(),
                name: None,
                source: "/host/project".into(),
                destination: "/data/project".into(),
                mode: "rw".into(),
                read_write: true,
            },
        ];
        assert!(deepest_covering_mount("/database", &mounts).is_none());
        assert_eq!(
            deepest_covering_mount("/data/project/cache", &mounts)
                .unwrap()
                .destination,
            "/data/project"
        );
    }

    #[test]
    fn docker_mount_policy_matrix() {
        let mount = |kind: &str, rw: bool| DockerMount {
            mount_type: kind.into(),
            name: Some("named".into()),
            source: "/sensitive/source".into(),
            destination: "/data".into(),
            mode: if rw { "rw" } else { "ro" }.into(),
            read_write: rw,
        };
        assert_eq!(
            persistence_facts("/data/pantoken", &[mount("volume", true)])
                .unwrap()
                .classification,
            PersistenceClassification::PersistentVolume
        );
        assert_eq!(
            persistence_facts("/data/pantoken", &[mount("bind", true)])
                .unwrap()
                .classification,
            PersistenceClassification::PersistentBind
        );
        assert_eq!(
            persistence_facts("/data/pantoken", &[mount("tmpfs", true)])
                .unwrap()
                .classification,
            PersistenceClassification::EphemeralTmpfs
        );
        assert_eq!(
            persistence_facts("/other", &[]).unwrap().classification,
            PersistenceClassification::EphemeralWritableLayer
        );
        assert_eq!(
            persistence_facts("/data/pantoken", &[mount("bind", false)]),
            Err(DockerTargetError::ReadOnlyMount)
        );
    }

    #[test]
    fn docker_command_builder_hostile_values() {
        let target = ResolvedDockerTarget {
            configured_name: "name;ignored".into(),
            container_id: "sha256:abc".into(),
            user: "1000:1000".into(),
            workdir: Some("/work dir".into()),
            pantoken_root: "/data/pantoken".into(),
            env: vec![("KEY".into(), "a'$; b".into())],
        };
        let upload = target.upload_words("/data/a '$; file").unwrap();
        assert_eq!(
            upload.iter().filter(|word| word.as_str() == "-i").count(),
            1
        );
        assert!(!upload.iter().any(|word| word == "-t" || word == "--tty"));
        assert_eq!(upload[upload.len() - 3], "cat > \"$1\"");
        assert_eq!(upload.last().unwrap(), "/data/a '$; file");
        let rendered = shell_join(&upload);
        assert!(rendered.contains("\\''"), "embedded quote must be escaped");
        assert!(!rendered.contains("name;ignored"));
        assert!(rendered.contains("cat >"));
    }

    #[test]
    fn normalize_rejects_relative_controls_and_parent_escape() {
        for path in ["relative", "/data/../etc", "/data\nroot", ""] {
            assert_eq!(
                normalize_absolute_path(path),
                Err(DockerTargetError::UnsafePath)
            );
        }
        assert_eq!(
            normalize_absolute_path("/data//project/./cache").unwrap(),
            "/data/project/cache"
        );
    }

    #[test]
    fn find_socket_mount_detects_docker_sock() {
        let mounts = vec![
            DockerMount {
                mount_type: "volume".into(),
                name: Some("data".into()),
                source: "/var/lib/docker/volumes/data".into(),
                destination: "/data".into(),
                mode: "rw".into(),
                read_write: true,
            },
            DockerMount {
                mount_type: "bind".into(),
                name: None,
                source: "/var/run/docker.sock".into(),
                destination: "/var/run/docker.sock".into(),
                mode: "rw".into(),
                read_write: true,
            },
        ];
        let socket = find_socket_mount(&mounts).unwrap();
        assert_eq!(socket.source, "/var/run/docker.sock");
        assert_eq!(socket.destination, "/var/run/docker.sock");
    }

    #[test]
    fn find_socket_mount_returns_none_when_no_socket() {
        let mounts = vec![DockerMount {
            mount_type: "bind".into(),
            name: None,
            source: "/host/project".into(),
            destination: "/data".into(),
            mode: "rw".into(),
            read_write: true,
        }];
        assert!(find_socket_mount(&mounts).is_none());
    }

    #[test]
    fn find_socket_mount_detects_destination_only() {
        let mounts = vec![DockerMount {
            mount_type: "bind".into(),
            name: None,
            source: "/custom/path".into(),
            destination: "/var/run/docker.sock".into(),
            mode: "rw".into(),
            read_write: true,
        }];
        assert!(find_socket_mount(&mounts).is_some());
    }

    #[test]
    fn compose_metadata_extracts_labels() {
        let mut labels = std::collections::HashMap::new();
        labels.insert("com.docker.compose.project".into(), "myapp".into());
        labels.insert("com.docker.compose.service".into(), "web".into());
        let (project, service) = compose_metadata(&labels);
        assert_eq!(project.as_deref(), Some("myapp"));
        assert_eq!(service.as_deref(), Some("web"));
    }

    #[test]
    fn compose_metadata_empty_when_no_labels() {
        let labels = std::collections::HashMap::new();
        let (project, service) = compose_metadata(&labels);
        assert_eq!(project, None);
        assert_eq!(service, None);
    }
}
