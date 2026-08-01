//! One-time phone bootstrap credentials and the `/bootstrap` exchange contract.
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub const LIFETIME: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
pub struct BootstrapState {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    credential: Option<IssuedCredential>,
    generation: u64,
}

struct IssuedCredential {
    value: String,
    issued_at: Instant,
    consumed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BootstrapStatus {
    pub issued: bool,
    pub expires_in_seconds: Option<u64>,
    pub generation: u64,
}

#[derive(Debug, Deserialize)]
pub struct ExchangeRequest {
    pub credential: Option<String>,
}

impl BootstrapState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                credential: None,
                generation: 0,
            })),
        }
    }

    pub async fn issue(&self) -> String {
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let value: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let mut inner = self.inner.lock().await;
        inner.generation = inner.generation.saturating_add(1);
        inner.credential = Some(IssuedCredential {
            value: value.clone(),
            issued_at: Instant::now(),
            consumed: false,
        });
        value
    }

    pub async fn valid(&self, candidate: &str) -> bool {
        let inner = self.inner.lock().await;
        inner.credential.as_ref().is_some_and(|credential| {
            !credential.consumed
                && credential.issued_at.elapsed() < LIFETIME
                && credential.value == candidate
        })
    }

    pub async fn consume(&self, candidate: &str) -> bool {
        let mut inner = self.inner.lock().await;
        let Some(credential) = inner.credential.as_mut() else {
            return false;
        };
        if credential.consumed || credential.issued_at.elapsed() >= LIFETIME {
            return false;
        }
        if credential.value != candidate {
            return false;
        }
        credential.consumed = true;
        true
    }

    pub async fn invalidate(&self) {
        let mut inner = self.inner.lock().await;
        inner.credential = None;
        inner.generation = inner.generation.saturating_add(1);
    }

    pub async fn status(&self) -> BootstrapStatus {
        let inner = self.inner.lock().await;
        BootstrapStatus {
            issued: inner.credential.as_ref().is_some_and(|credential| {
                !credential.consumed && credential.issued_at.elapsed() < LIFETIME
            }),
            expires_in_seconds: inner.credential.as_ref().and_then(|credential| {
                if credential.consumed {
                    return None;
                }
                LIFETIME
                    .checked_sub(credential.issued_at.elapsed())
                    .map(|duration| duration.as_secs())
            }),
            generation: inner.generation,
        }
    }
}

impl Default for BootstrapState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn credential_is_random_and_one_time() {
        let state = BootstrapState::new();
        let first = state.issue().await;
        let second = state.issue().await;
        assert_ne!(first, second);
        assert!(!state.consume(&first).await);
        assert!(state.consume(&second).await);
        assert!(!state.consume(&second).await);
    }

    #[tokio::test]
    async fn invalidation_rejects_outstanding_link() {
        let state = BootstrapState::new();
        let credential = state.issue().await;
        state.invalidate().await;
        assert!(!state.consume(&credential).await);
    }
}
