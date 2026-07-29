//! Independently authored inventory of the public HTTP/SSE contracts consumed by Pantoken.
//!
//! This is deliberately not generated from a daemon source tree.  It records the
//! observable wire surface used by [`super::daemon_client::DaemonClient`].

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndpointContract {
    pub client_method: &'static str,
    pub method: &'static str,
    pub path_template: &'static str,
    pub success_policy: &'static str,
    pub request_body: &'static str,
    pub response_schema: &'static str,
    pub representative_errors: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupContract {
    pub operation: &'static str,
    pub public_inputs_outputs: &'static str,
}

macro_rules! endpoint {
    ($name:literal, $method:literal, $path:literal, $success:literal, $body:literal, $response:literal, $errors:literal) => {
        EndpointContract {
            client_method: $name,
            method: $method,
            path_template: $path,
            success_policy: $success,
            request_body: $body,
            response_schema: $response,
            representative_errors: $errors,
        }
    };
}

/// Every HTTP/SSE operation currently invoked by Pantoken's live client.
pub const ENDPOINTS: &[EndpointContract] = &[
    endpoint!(
        "health",
        "GET",
        "/health",
        "200 + HealthResponse",
        "none",
        "HealthResponse",
        "401, 503"
    ),
    endpoint!(
        "terminate",
        "POST",
        "/terminate",
        "200",
        "none",
        "empty",
        "401, 404, 500"
    ),
    endpoint!(
        "claim_lease",
        "POST",
        "/tui-attachment/claim",
        "200 + TuiAttachClaimResponse",
        "TuiAttachClaimRequest { pid, terminal_label, process_start_token? }",
        "TuiAttachClaimResponse",
        "401, 409, 500"
    ),
    endpoint!(
        "heartbeat",
        "POST",
        "/tui-attachment/heartbeat",
        "2xx (200 expected); 404/409 end lease",
        "TuiAttachHeartbeatRequest { lease_id, pid, process_start_token? }",
        "empty",
        "401, 404, 409, 500"
    ),
    endpoint!(
        "release_lease",
        "DELETE",
        "/tui-attachment/{lease_id}",
        "best-effort DELETE; caller observes no status/error",
        "none",
        "empty",
        "server failures are intentionally swallowed by release_lease"
    ),
    endpoint!(
        "prompt",
        "POST",
        "/prompt",
        "202 + PromptAccepted",
        "PromptRequest { content, max_tool_turns? }",
        "PromptAccepted",
        "401, 409, 422, 500"
    ),
    endpoint!(
        "queue_turn_input",
        "POST",
        "/turn/input",
        "202",
        "PendingTurnInputRequest { content }",
        "empty",
        "401, 409, 422, 429"
    ),
    endpoint!(
        "turn_input_snapshot",
        "GET",
        "/turn/input",
        "200 + PendingTurnInputSnapshot",
        "none",
        "PendingTurnInputSnapshot",
        "401, 404, 500"
    ),
    endpoint!(
        "dequeue_newest_input",
        "DELETE",
        "/turn/input/newest",
        "200 or 409 (both accepted no-op outcomes)",
        "none",
        "empty",
        "401, 404, 500"
    ),
    endpoint!(
        "toggle_adventurous_handoff",
        "POST",
        "/adventurous-handoff",
        "2xx + { enabled }",
        "none",
        "{ enabled: bool }",
        "401, 404, 500"
    ),
    endpoint!(
        "cancel_turn",
        "POST",
        "/turn/cancel",
        "202 or 409 (both accepted no-op outcomes)",
        "none",
        "empty or { prompt_id? }",
        "401, 404, 500"
    ),
    endpoint!(
        "state",
        "GET",
        "/state",
        "200 + SessionStateSnapshot",
        "none",
        "SessionStateSnapshot",
        "401, 404, 500"
    ),
    endpoint!(
        "history",
        "GET",
        "/history?offset={offset}&limit={limit}",
        "200 + SessionHistorySnapshot",
        "none; optional offset/limit query",
        "SessionHistorySnapshot",
        "401, 400, 404, 500"
    ),
    endpoint!(
        "files",
        "GET",
        "/files?include_ignored={bool}",
        "200 + FileCatalogResponse",
        "none; optional include_ignored query",
        "FileCatalogResponse",
        "401, 404, 500"
    ),
    endpoint!(
        "file_catalog",
        "GET",
        "/files",
        "200 + FileCatalogResponse",
        "none (alias method)",
        "FileCatalogResponse",
        "401, 404, 500"
    ),
    endpoint!(
        "set_model",
        "POST",
        "/model",
        "200; 409 only when code=no_change",
        "ModelRequest { model, reasoning_effort? }",
        "empty or ErrorBody",
        "401, 409, 422, 500"
    ),
    endpoint!(
        "set_title",
        "POST",
        "/title",
        "200",
        "SessionTitleRequest { title }",
        "empty",
        "401, 400, 500"
    ),
    endpoint!(
        "respond_interrogative",
        "POST",
        "/interrogative/{id}/respond",
        "any 2xx",
        "InterrogativeResponse",
        "empty",
        "401, 404, 409, 422, 500"
    ),
    endpoint!(
        "set_permission_mode",
        "POST",
        "/permission-monitor",
        "200",
        "PermissionMonitorRequest { mode }",
        "empty",
        "401, 400, 500"
    ),
    endpoint!(
        "get_permission_monitor",
        "GET",
        "/permission-monitor",
        "200 + PermissionMonitorResponse",
        "none",
        "PermissionMonitorResponse",
        "401, 404, 500"
    ),
    endpoint!(
        "get_notification_autodrain",
        "GET",
        "/notification-autodrain",
        "200 + NotificationAutodrainResponse",
        "none",
        "NotificationAutodrainResponse",
        "401, 404, 500"
    ),
    endpoint!(
        "set_notification_autodrain",
        "POST",
        "/notification-autodrain",
        "200",
        "{ enabled: bool }",
        "empty",
        "401, 400, 500"
    ),
    endpoint!(
        "clear", "POST", "/clear", "200", "none", "empty", "401, 500"
    ),
    endpoint!(
        "jobs",
        "GET",
        "/jobs",
        "200 + Vec<JobSnapshot>",
        "none",
        "Vec<JobSnapshot>",
        "401, 500"
    ),
    endpoint!(
        "delete_todo",
        "DELETE",
        "/todos/{id}",
        "2xx; 204 success",
        "none",
        "empty or TodoDeleteConflictResponse",
        "401, 404, 409, 500"
    ),
    endpoint!(
        "compact",
        "POST",
        "/compact",
        "202",
        "CompactRequest or JSON null",
        "empty",
        "401, 409, 500"
    ),
    endpoint!(
        "rewind",
        "POST",
        "/rewind",
        "202",
        "RewindRequest",
        "empty",
        "401, 400, 409, 422, 500"
    ),
    endpoint!(
        "set_facet",
        "POST",
        "/facet",
        "200",
        "FacetRequest { facet }",
        "empty",
        "401, 404, 422, 500"
    ),
    endpoint!(
        "reload", "POST", "/reload", "200", "none", "empty", "401, 500"
    ),
    endpoint!(
        "reset_shell",
        "POST",
        "/reset-shell",
        "200",
        "none",
        "empty",
        "401, 500"
    ),
    endpoint!(
        "goal_set",
        "POST",
        "/goal",
        "200",
        "GoalSetRequest { summary }",
        "empty",
        "401, 400, 409, 500"
    ),
    endpoint!(
        "goal_pause",
        "POST",
        "/goal/pause",
        "200 or 204",
        "none",
        "empty",
        "401, 404, 409, 500"
    ),
    endpoint!(
        "goal_resume",
        "POST",
        "/goal/resume",
        "200 or 204",
        "none",
        "empty",
        "401, 404, 409, 500"
    ),
    endpoint!(
        "goal_clear",
        "POST",
        "/goal/clear",
        "200 or 204",
        "none",
        "empty",
        "401, 404, 500"
    ),
    endpoint!(
        "mcp_server_action",
        "POST",
        "/mcp/{server}/{action}",
        "200",
        "none; server/action path params",
        "empty",
        "401, 404, 409, 500"
    ),
    endpoint!(
        "subscribe",
        "GET",
        "/events",
        "200 text/event-stream; reconnect on end/timeout",
        "none; optional Last-Event-ID on reconnect",
        "SseEnvelope<DaemonEvent>",
        "401, 404, 500"
    ),
];

/// Startup is process/CLI behavior, not an HTTP endpoint. Kept separate so the
/// endpoint matrix does not accidentally imply coverage of spawn parsing.
pub const STARTUP: &[StartupContract] = &[
    StartupContract {
        operation: "new",
        public_inputs_outputs: "working directory/options -> session_id, port, auth token from public startup output",
    },
    StartupContract {
        operation: "resume",
        public_inputs_outputs: "working directory, session id, options -> session_id, port, auth token from public startup output",
    },
];

/// The stable method-name vocabulary is intentionally explicit: adding a client
/// operation requires adding its inventory row and updating this gate together.
pub const INVENTORIED_METHOD_NAMES: &[&str] = &[
    "health",
    "terminate",
    "claim_lease",
    "heartbeat",
    "release_lease",
    "prompt",
    "queue_turn_input",
    "turn_input_snapshot",
    "dequeue_newest_input",
    "toggle_adventurous_handoff",
    "cancel_turn",
    "state",
    "history",
    "files",
    "file_catalog",
    "set_model",
    "set_title",
    "respond_interrogative",
    "set_permission_mode",
    "get_permission_monitor",
    "get_notification_autodrain",
    "set_notification_autodrain",
    "clear",
    "jobs",
    "delete_todo",
    "compact",
    "rewind",
    "set_facet",
    "reload",
    "reset_shell",
    "goal_set",
    "goal_pause",
    "goal_resume",
    "goal_clear",
    "mcp_server_action",
    "subscribe",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_client_endpoint_contract_matrix() {
        assert_eq!(ENDPOINTS.len(), INVENTORIED_METHOD_NAMES.len());
        for endpoint in ENDPOINTS {
            assert!(!endpoint.client_method.is_empty());
            assert!(matches!(endpoint.method, "GET" | "POST" | "DELETE"));
            assert!(endpoint.path_template.starts_with('/'));
            assert!(!endpoint.success_policy.is_empty());
            assert!(!endpoint.request_body.is_empty());
            assert!(!endpoint.response_schema.is_empty());
            assert!(!endpoint.representative_errors.is_empty());
            if endpoint.client_method == "release_lease" {
                assert!(endpoint.representative_errors.contains("swallowed"));
            } else {
                assert!(
                    endpoint
                        .representative_errors
                        .split(',')
                        .all(|s| s.trim().parse::<u16>().is_ok())
                );
            }
            if endpoint.client_method == "release_lease" {
                assert!(endpoint.success_policy.contains("best-effort"));
            } else {
                assert!(endpoint.success_policy.chars().any(|c| c.is_ascii_digit()));
            }
        }
    }

    #[test]
    fn daemon_client_method_name_set_matches_inventory_rows() {
        let mut rows: Vec<_> = ENDPOINTS.iter().map(|e| e.client_method).collect();
        let mut names = INVENTORIED_METHOD_NAMES.to_vec();
        rows.sort_unstable();
        names.sort_unstable();
        assert_eq!(
            rows, names,
            "client method additions require an inventory update"
        );
    }
}
