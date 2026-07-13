//! Merge warm in-memory sessions with on-disk session-list entries.
//!
//! Faithful port of `server/src/shared/session-list.ts`.

use std::collections::HashSet;

use pantoken_protocol::session_driver::SessionListEntry;

/// Combine warm (in-memory) and on-disk session entries, deduped by session id.
/// A warm session that's also on disk keeps its richer disk entry; warm-only
/// entries come first. The warm entry's `display_name` is overlaid onto the
/// disk entry when present, since it reflects the live `session_title` — which
/// may be newer than what the daemon has flushed to `session.json` on disk.
pub fn merge_session_lists(
    on_disk: &[SessionListEntry],
    warm: &[SessionListEntry],
) -> Vec<SessionListEntry> {
    use std::collections::HashMap;
    let on_disk_ids: HashSet<&str> = on_disk
        .iter()
        .map(|entry| entry.session_id.as_str())
        .collect();
    let warm_by_id: HashMap<&str, &SessionListEntry> = warm
        .iter()
        .filter(|entry| on_disk_ids.contains(entry.session_id.as_str()))
        .map(|entry| (entry.session_id.as_str(), entry))
        .collect();
    let mut merged: Vec<SessionListEntry> = warm
        .iter()
        .filter(|entry| !on_disk_ids.contains(entry.session_id.as_str()))
        .cloned()
        .collect();
    merged.extend(
        on_disk
            .iter()
            .map(|e| match warm_by_id.get(e.session_id.as_str()) {
                Some(w) if w.display_name.is_some() => SessionListEntry {
                    display_name: w.display_name.clone(),
                    ..e.clone()
                },
                _ => e.clone(),
            }),
    );
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(session_id: &str) -> SessionListEntry {
        entry_with(session_id, "", 0)
    }

    fn entry_with(session_id: &str, preview: &str, user_message_count: i64) -> SessionListEntry {
        SessionListEntry {
            session_id: session_id.to_string(),
            path: format!("/sessions/{session_id}.jsonl"),
            cwd: "/proj".to_string(),
            display_name: None,
            preview: preview.to_string(),
            user_message_count,
            updated_at: "2026-06-18T00:00:00.000Z".to_string(),
            created_at: "2026-06-18T00:00:00.000Z".to_string(),
            last_user_message_at: "2026-06-18T00:00:00.000Z".to_string(),
            parent_session_path: None,
            usage: None,
            archived: false,
            worktree: None,
        }
    }

    fn entry_with_title(session_id: &str, display_name: Option<&str>) -> SessionListEntry {
        let mut e = entry(session_id);
        e.display_name = display_name.map(|s| s.to_string());
        e
    }

    #[test]
    fn includes_a_warm_session_that_is_not_on_disk_yet() {
        let on_disk = vec![entry("old")];
        let warm = vec![entry_with("fresh", "warm placeholder", 0)];
        let merged = merge_session_lists(&on_disk, &warm);
        let ids: Vec<&str> = merged
            .iter()
            .map(|entry| entry.session_id.as_str())
            .collect();
        assert_eq!(ids, vec!["fresh", "old"]);
    }

    #[test]
    fn a_warm_session_already_on_disk_keeps_its_richer_disk_entry() {
        let on_disk = vec![entry_with("s1", "real first message", 4)];
        let warm = vec![entry_with("s1", "", 0)];
        let merged = merge_session_lists(&on_disk, &warm);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].preview, "real first message");
        assert_eq!(merged[0].user_message_count, 4);
    }

    #[test]
    fn no_warm_sessions_leaves_the_disk_list_untouched() {
        let on_disk = vec![entry("a"), entry("b")];
        let merged = merge_session_lists(&on_disk, &[]);
        assert_eq!(merged, on_disk);
    }

    #[test]
    fn warm_only_entries_precede_disk_entries() {
        let merged = merge_session_lists(
            &[entry("disk1"), entry("disk2")],
            &[entry("warm1"), entry("warm2")],
        );
        let ids: Vec<&str> = merged
            .iter()
            .map(|entry| entry.session_id.as_str())
            .collect();
        assert_eq!(ids, vec!["warm1", "warm2", "disk1", "disk2"]);
    }

    #[test]
    fn warm_title_overlays_disk_entry_when_disk_has_no_title() {
        let on_disk = vec![entry_with_title("s1", None)];
        let warm = vec![entry_with_title("s1", Some("Live Title"))];
        let merged = merge_session_lists(&on_disk, &warm);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].display_name.as_deref(), Some("Live Title"));
    }

    #[test]
    fn warm_title_overlays_disk_entry_when_disk_title_is_stale() {
        let on_disk = vec![entry_with_title("s1", Some("Old Title"))];
        let warm = vec![entry_with_title("s1", Some("New Title"))];
        let merged = merge_session_lists(&on_disk, &warm);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].display_name.as_deref(), Some("New Title"));
    }

    #[test]
    fn warm_entry_without_title_keeps_disk_title() {
        let on_disk = vec![entry_with_title("s1", Some("Disk Title"))];
        let warm = vec![entry_with_title("s1", None)];
        let merged = merge_session_lists(&on_disk, &warm);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].display_name.as_deref(), Some("Disk Title"));
    }
}
