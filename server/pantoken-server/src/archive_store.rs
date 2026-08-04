//! The archive index: pantoken's source of truth for which sessions the operator has
//! archived. Keyed by the session's switch-key path — the live `PolytokenDriver`
//! uses the `session.json` path, the mock uses the `.jsonl` path; the store
//! itself is path-agnostic.
//!
//! Faithful port of `server/src/archive-store.ts`.
//!
//! **I/O failure policy:** `new` and `load` degrade gracefully — they log via
//! `tracing::error!` and continue with in-memory state rather than panicking.
//! A failed archive write never crashes the server, but `set` returns its
//! diagnostic so the driver can report `OperationFailed` instead of claiming
//! durable success. The in-memory set remains correct for the session lifetime.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub struct ArchiveStore {
    file: PathBuf,
    archived: HashSet<String>,
}

impl ArchiveStore {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        let file = file.into();
        if let Some(parent) = file.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                tracing::error!("[archive] failed to create {}: {e}", parent.display());
            }
        }
        let mut store = Self {
            file,
            archived: HashSet::new(),
        };
        store.load();
        store
    }

    pub fn has(&self, path: &str) -> bool {
        self.archived.contains(path)
    }

    /// Set/clear the archived flag for a session path. Persists only on an actual change.
    /// The in-memory state changes only after persistence succeeds, so a failed write can
    /// be retried with the same requested state without being mistaken for a no-op.
    pub fn set(&mut self, path: &str, archived: bool) -> Result<(), String> {
        let was_archived = self.archived.contains(path);
        if was_archived == archived {
            return Ok(());
        }
        if archived {
            self.archived.insert(path.to_string());
        } else {
            self.archived.remove(path);
        }
        if let Err(error) = self.persist() {
            if was_archived {
                self.archived.insert(path.to_string());
            } else {
                self.archived.remove(path);
            }
            return Err(error);
        }
        Ok(())
    }

    fn load(&mut self) {
        if !Path::new(&self.file).exists() {
            return;
        }
        match fs::read_to_string(&self.file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        {
            Some(arr) => {
                let count = arr.len();
                for path in arr {
                    self.archived.insert(path);
                }
                if count > 0 {
                    tracing::info!("[archive] loaded {count} archived session(s)");
                }
            }
            None => tracing::error!("[archive] failed to load index"),
        }
    }

    fn persist(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&self.archived.iter().collect::<Vec<_>>())
            .map_err(|error| format!("failed to serialize archive index: {error}"))?;
        fs::write(&self.file, json)
            .map_err(|error| format!("failed to write {}: {error}", self.file.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn has_is_false_for_an_unknown_path() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("archived.json");
        assert!(!ArchiveStore::new(file).has("/a.jsonl"));
    }

    #[test]
    fn set_true_archives_set_false_unarchives() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("archived.json");
        let mut store = ArchiveStore::new(file);
        store.set("/a.jsonl", true).unwrap();
        assert!(store.has("/a.jsonl"));
        store.set("/a.jsonl", false).unwrap();
        assert!(!store.has("/a.jsonl"));
    }

    #[test]
    fn persists_across_instances_the_file_is_the_source_of_truth() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("archived.json");
        let mut s1 = ArchiveStore::new(&file);
        s1.set("/a.jsonl", true).unwrap();
        s1.set("/b.jsonl", true).unwrap();
        let s2 = ArchiveStore::new(&file);
        assert!(s2.has("/a.jsonl"));
        assert!(s2.has("/b.jsonl"));
        assert!(!s2.has("/c.jsonl"));
    }

    #[test]
    fn unarchiving_removes_the_path_from_the_persisted_set() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("archived.json");
        let mut s1 = ArchiveStore::new(&file);
        s1.set("/a.jsonl", true).unwrap();
        s1.set("/a.jsonl", false).unwrap();
        let raw = fs::read_to_string(&file).unwrap();
        let arr: Vec<String> = serde_json::from_str(&raw).unwrap();
        assert_eq!(arr, Vec::<String>::new());
        assert!(!ArchiveStore::new(&file).has("/a.jsonl"));
    }

    #[test]
    fn a_missing_index_file_loads_as_empty_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!ArchiveStore::new(dir.path().join("nope.json")).has("/a.jsonl"));
    }

    #[test]
    fn archive_store_persistence_failure_can_be_retried() {
        // Use a directory at the persistence path so fs::write fails
        // deterministically on every platform and under every test user.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("archived.json");
        fs::create_dir(&file).unwrap();
        let mut store = ArchiveStore::new(&file);

        let result = store.set("/b.jsonl", true);
        assert!(result.is_err(), "persistence failure must be returned");
        assert!(
            !store.has("/b.jsonl"),
            "failed persistence must not commit in-memory state"
        );

        fs::remove_dir(&file).unwrap();
        store.set("/b.jsonl", true).unwrap();
        assert!(store.has("/b.jsonl"));
        assert!(ArchiveStore::new(&file).has("/b.jsonl"));
    }
}
