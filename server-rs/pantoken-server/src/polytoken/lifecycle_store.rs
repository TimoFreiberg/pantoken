//! Pantoken-owned lifecycle and tombstone state.
//!
//! Missing state is an empty store. Corrupt state fails closed: callers receive an
//! error rather than risking resurrection of a destroyed session.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LifecycleState {
    EmptyDefault,
    AcceptedPrompt,
    LiveConfigAction,
    DestroyPending,
    Tombstoned,
    Unknown,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Persisted {
    #[serde(default)]
    states: HashMap<String, LifecycleState>,
}

#[derive(Debug)]
pub struct LifecycleStore {
    path: PathBuf,
    states: HashMap<String, LifecycleState>,
    load_error: Option<String>,
}

impl LifecycleStore {
    pub fn new(root: impl AsRef<Path>) -> Self {
        let path = root.as_ref().join("session-lifecycle.json");
        let (states, load_error) = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Persisted>(&bytes) {
                Ok(persisted) => (persisted.states, None),
                Err(error) => (HashMap::new(), Some(format!("invalid lifecycle store: {error}"))),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (HashMap::new(), None)
            }
            Err(error) => (HashMap::new(), Some(format!("could not read lifecycle store: {error}"))),
        };
        Self { path, states, load_error }
    }

    pub fn ensure_healthy(&self) -> Result<(), String> {
        self.load_error.clone().map_or(Ok(()), Err)
    }

    pub fn state(&self, key: &str) -> LifecycleState {
        self.states.get(key).copied().unwrap_or(LifecycleState::Unknown)
    }

    pub fn is_tombstoned(&self, key: &str) -> bool {
        matches!(self.state(key), LifecycleState::Tombstoned)
    }

    pub fn set(&mut self, key: impl Into<String>, state: LifecycleState) -> Result<(), String> {
        self.ensure_healthy()?;
        self.states.insert(key.into(), state);
        self.persist()
    }

    pub fn remove(&mut self, key: &str) -> Result<(), String> {
        self.ensure_healthy()?;
        self.states.remove(key);
        self.persist()
    }

    pub fn tombstones(&self) -> HashSet<String> {
        self.states
            .iter()
            .filter_map(|(key, state)| {
                (*state == LifecycleState::Tombstoned).then_some(key.clone())
            })
            .collect()
    }

    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&Persisted { states: self.states.clone() })
            .map_err(|error| format!("serialize lifecycle store: {error}"))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, bytes).map_err(|error| format!("write lifecycle store: {error}"))?;
        fs::rename(&tmp, &self.path).map_err(|error| format!("replace lifecycle store: {error}"))
    }
}
