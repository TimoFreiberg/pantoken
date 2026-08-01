//! Phone-access control-plane DTOs and origin/status policy.
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
            .map(|parsed| format!("{}//{}/", parsed.scheme(), parsed.host_str().unwrap_or("")))
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
