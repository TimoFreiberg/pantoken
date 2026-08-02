//! Phone-access control-plane DTOs and origin/status policy.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteAccessState {
    Disabled,
    Starting,
    Ready,
    Stopping,
    KeychainError,
    SidecarUnavailable,
    VerificationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteAccessStatusDto {
    pub state: RemoteAccessState,
    pub enabled: bool,
    pub hub_port: u16,
    pub origin: Option<String>,
    pub endpoint_status: String,
    pub bootstrap_available: bool,
}

pub fn redact_origin(origin: Option<&str>) -> Option<String> {
    origin.map(|value| {
        url::Url::parse(value)
            .map(|parsed| {
                let host = value
                    .split_once("://")
                    .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())
                    .and_then(|authority| {
                        authority
                            .rsplit_once('@')
                            .map_or(Some(authority), |(_, host)| Some(host))
                    })
                    .unwrap_or(parsed.host_str().unwrap_or(""));
                let host =
                    if host.contains(':') && !host.starts_with('[') && parsed.port().is_none() {
                        format!("[{host}]")
                    } else {
                        host.to_owned()
                    };
                format!("{}://{host}/", parsed.scheme())
            })
            .unwrap_or_else(|_| "configured HTTPS origin".to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_dto_contains_no_secret_fields() {
        let dto = RemoteAccessStatusDto {
            state: RemoteAccessState::Ready,
            enabled: true,
            hub_port: 8787,
            origin: redact_origin(Some("https://Mini.Example.test/path")),
            endpoint_status: "verified".into(),
            bootstrap_available: true,
        };
        let json = serde_json::to_string(&dto).unwrap();
        assert!(!json.contains("token"));
        assert!(!json.contains("credential"));
        assert_eq!(dto.origin.as_deref(), Some("https://Mini.Example.test/"));
    }
}
