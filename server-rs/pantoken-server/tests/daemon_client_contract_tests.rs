//! Provider-free black-box contracts for the public DaemonClient wire surface.
//!
//! These cases intentionally use a real TCP listener rather than `Router::oneshot`:
//! the client is exercised exactly as production uses it, including auth, URL
//! construction, body serialization, timeout handling, and SSE framing.

use std::{sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use pantoken_daemon_types::{CompactRequest, InterrogativeResponse, RewindRequest};
use pantoken_server::polytoken::{daemon_client::DaemonClient, endpoint_inventory::ENDPOINTS};
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::Mutex};
const TOKEN: &str = "contract-token-never-print-this";
const SESSION: &str = "contract-session";

#[derive(Debug, Clone)]
struct ExecutableContract {
    name: &'static str,
    method: &'static str,
    path: &'static str,
    request_body: Option<&'static str>,
    inventory_request_body: &'static str,
    response_schema: &'static str,
    accepted_statuses: &'static [StatusCode],
    rejected_status: StatusCode,
}

const EXPECTED_EXECUTABLE_CONTRACTS: &[ExecutableContract] = &[
    ExecutableContract {
        name: "health",
        method: "GET",
        path: "/health",
        request_body: None,
        inventory_request_body: "none",
        response_schema: "HealthResponse",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::UNAUTHORIZED,
    },
    ExecutableContract {
        name: "terminate",
        method: "POST",
        path: "/terminate",
        request_body: None,
        inventory_request_body: "none",
        response_schema: "empty",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::INTERNAL_SERVER_ERROR,
    },
    ExecutableContract {
        name: "claim_lease",
        method: "POST",
        path: "/tui-attachment/claim",
        request_body: Some(r#"{"pid":7,"terminal_label":"contract"}"#),
        inventory_request_body: "TuiAttachClaimRequest { pid, terminal_label, process_start_token? }",
        response_schema: "TuiAttachClaimResponse",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::CONFLICT,
    },
    ExecutableContract {
        name: "heartbeat",
        method: "POST",
        path: "/tui-attachment/heartbeat",
        request_body: Some(r#"{"lease_id":"lease","pid":7}"#),
        inventory_request_body: "TuiAttachHeartbeatRequest { lease_id, pid, process_start_token? }",
        response_schema: "empty",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::CONFLICT,
    },
    ExecutableContract {
        name: "release_lease",
        method: "DELETE",
        path: "/tui-attachment/lease",
        request_body: None,
        inventory_request_body: "none",
        response_schema: "empty",
        accepted_statuses: &[StatusCode::NO_CONTENT],
        rejected_status: StatusCode::NOT_FOUND,
    },
    ExecutableContract {
        name: "state",
        method: "GET",
        path: "/state",
        request_body: None,
        inventory_request_body: "none",
        response_schema: "SessionStateSnapshot",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::INTERNAL_SERVER_ERROR,
    },
    ExecutableContract {
        name: "history",
        method: "GET",
        path: "/history?offset=2&limit=3",
        request_body: None,
        inventory_request_body: "none; optional offset/limit query",
        response_schema: "SessionHistorySnapshot",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::BAD_REQUEST,
    },
    ExecutableContract {
        name: "files",
        method: "GET",
        path: "/files?include_ignored=true",
        request_body: None,
        inventory_request_body: "none; optional include_ignored query",
        response_schema: "FileCatalogResponse",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::NOT_FOUND,
    },
    ExecutableContract {
        name: "file_catalog",
        method: "GET",
        path: "/files",
        request_body: None,
        inventory_request_body: "none (alias method)",
        response_schema: "FileCatalogResponse",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::NOT_FOUND,
    },
    ExecutableContract {
        name: "jobs",
        method: "GET",
        path: "/jobs",
        request_body: None,
        inventory_request_body: "none",
        response_schema: "Vec<JobSnapshot>",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::INTERNAL_SERVER_ERROR,
    },
    ExecutableContract {
        name: "clear",
        method: "POST",
        path: "/clear",
        request_body: None,
        inventory_request_body: "none",
        response_schema: "empty",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::UNAUTHORIZED,
    },
    ExecutableContract {
        name: "goal_pause",
        method: "POST",
        path: "/goal/pause",
        request_body: None,
        inventory_request_body: "none",
        response_schema: "empty",
        accepted_statuses: &[StatusCode::OK, StatusCode::NO_CONTENT],
        rejected_status: StatusCode::NOT_FOUND,
    },
    ExecutableContract {
        name: "compact",
        method: "POST",
        path: "/compact",
        request_body: Some(r#"{"guidance":"g"}"#),
        inventory_request_body: "CompactRequest or JSON null",
        response_schema: "empty",
        accepted_statuses: &[StatusCode::ACCEPTED],
        rejected_status: StatusCode::CONFLICT,
    },
    ExecutableContract {
        name: "rewind",
        method: "POST",
        path: "/rewind",
        request_body: Some(r#"{"domains":["conversation"],"to_message_index":2}"#),
        inventory_request_body: "RewindRequest",
        response_schema: "empty",
        accepted_statuses: &[StatusCode::ACCEPTED],
        rejected_status: StatusCode::UNPROCESSABLE_ENTITY,
    },
    ExecutableContract {
        name: "respond_interrogative",
        method: "POST",
        path: "/interrogative/q%201/respond",
        request_body: Some(r#"{"kind":"cancel"}"#),
        inventory_request_body: "InterrogativeResponse",
        response_schema: "empty",
        accepted_statuses: &[StatusCode::NO_CONTENT],
        rejected_status: StatusCode::NOT_FOUND,
    },
    ExecutableContract {
        name: "toggle_adventurous_handoff",
        method: "POST",
        path: "/adventurous-handoff",
        request_body: None,
        inventory_request_body: "none",
        response_schema: "{ enabled: bool }",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::UNAUTHORIZED,
    },
    ExecutableContract {
        name: "cancel_turn",
        method: "POST",
        path: "/turn/cancel",
        request_body: None,
        inventory_request_body: "none",
        response_schema: "empty or { prompt_id? }",
        accepted_statuses: &[StatusCode::ACCEPTED],
        rejected_status: StatusCode::INTERNAL_SERVER_ERROR,
    },
    ExecutableContract {
        name: "set_title",
        method: "POST",
        path: "/title",
        request_body: Some(r#"{"title":"title"}"#),
        inventory_request_body: "SessionTitleRequest { title }",
        response_schema: "empty",
        accepted_statuses: &[StatusCode::OK],
        rejected_status: StatusCode::BAD_REQUEST,
    },
];

fn inventory_contract(
    name: &str,
) -> &'static pantoken_server::polytoken::endpoint_inventory::EndpointContract {
    ENDPOINTS
        .iter()
        .find(|endpoint| endpoint.client_method == name)
        .expect("contract must be inventoried")
}

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    auth: Option<String>,
    body: String,
}

#[derive(Clone)]
struct Harness {
    seen: Arc<Mutex<Vec<Seen>>>,
    status: StatusCode,
    body: String,
    delay: Option<Duration>,
}

async fn serve(listener: TcpListener, harness: Harness) {
    let app = Router::new()
        .fallback(any(record_request))
        .with_state(harness);
    axum::serve(listener, app).await.expect("contract server");
}

async fn record_request(State(h): State<Harness>, request: Request<Body>) -> Response<Body> {
    let (parts, body) = request.into_parts();
    if let Some(delay) = h.delay {
        tokio::time::sleep(delay).await;
    }
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("request body");
    h.seen.lock().await.push(Seen {
        method: parts.method.to_string(),
        path: parts.uri.to_string(),
        auth: parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        body: String::from_utf8(bytes.to_vec()).expect("utf8 body"),
    });
    (h.status, h.body).into_response()
}

async fn call<F, Fut, R>(status: StatusCode, body: Value, f: F) -> (Vec<Seen>, R)
where
    F: FnOnce(DaemonClient) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    call_raw(status, body.to_string(), f).await
}

async fn lease_lifecycle(body: Value) -> Vec<Seen> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let server = tokio::spawn(serve(
        listener,
        Harness {
            seen: seen.clone(),
            status: StatusCode::OK,
            body: body.to_string(),
            delay: None,
        },
    ));
    let client = DaemonClient::new(SESSION.into(), port, 7, Some(TOKEN.into()));
    client.claim_lease("contract").await.expect("claim");
    tokio::time::sleep(Duration::from_millis(1100)).await;
    client.release_lease().await;
    server.abort();
    seen.lock().await.clone()
}

async fn call_raw<F, Fut, R>(status: StatusCode, body: String, f: F) -> (Vec<Seen>, R)
where
    F: FnOnce(DaemonClient) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let seen = Arc::new(Mutex::new(Vec::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let server = tokio::spawn(serve(
        listener,
        Harness {
            seen: seen.clone(),
            status,
            body: body.to_string(),
            delay: None,
        },
    ));
    let client = DaemonClient::new(SESSION.into(), port, 7, Some(TOKEN.into()));
    let result = f(client).await;
    server.abort();
    (seen.lock().await.clone(), result)
}

fn assert_request(seen: &[Seen], method: &str, path: &str, body: Option<Value>) {
    assert_eq!(seen.len(), 1, "expected exactly one network request");
    let request = &seen[0];
    assert_eq!(request.method, method);
    assert_eq!(request.path, path);
    assert_eq!(
        request.auth.as_deref(),
        Some(format!("Bearer {TOKEN}").as_str())
    );
    match body {
        Some(expected) => assert_eq!(
            serde_json::from_str::<Value>(&request.body).unwrap(),
            expected
        ),
        None => assert!(
            request.body.is_empty(),
            "expected no body, got {}",
            request.body
        ),
    }
}

#[tokio::test]
async fn daemon_client_endpoint_contract_matrix() {
    let expected: std::collections::BTreeSet<_> = EXPECTED_EXECUTABLE_CONTRACTS
        .iter()
        .map(|c| c.name)
        .collect();
    assert_eq!(
        expected.len(),
        18,
        "the bounded slice must contain eighteen distinct cases"
    );
    for contract in EXPECTED_EXECUTABLE_CONTRACTS {
        let inventory = inventory_contract(contract.name);
        assert_eq!(inventory.method, contract.method);
        let normalized_path = inventory
            .path_template
            .replace("{id}", "q%201")
            .replace("{lease_id}", "lease")
            .replace("{offset}", "2")
            .replace("{limit}", "3")
            .replace("{bool}", "true");
        assert_eq!(normalized_path, contract.path);
        assert_eq!(inventory.request_body, contract.inventory_request_body);
        if let Some(body) = contract.request_body {
            assert_eq!(
                serde_json::from_str::<Value>(body).unwrap().is_object(),
                true
            );
        }
        assert_eq!(inventory.response_schema, contract.response_schema);
        for accepted_status in contract.accepted_statuses {
            let accepted_code = accepted_status.as_u16().to_string();
            assert!(
                inventory.success_policy.contains(&accepted_code)
                    || (accepted_status.is_success() && inventory.success_policy.contains("2xx")),
                "{} missing accepted status {}",
                contract.name,
                accepted_code
            );
        }
        if contract.name == "cancel_turn" {
            assert!(
                inventory.success_policy.contains("409"),
                "cancel_turn must separately represent accepted 409 no-op"
            );
        }
        assert!(
            inventory
                .representative_errors
                .split(',')
                .any(|status| status.trim() == contract.rejected_status.as_u16().to_string()),
            "{} missing rejected status {}",
            contract.name,
            contract.rejected_status
        );
    }

    let mut executed = std::collections::BTreeSet::new();

    let health_body = json!({
        "last_heartbeat_at":"2024-01-01T00:00:00Z","parent_session_id":{"kind":"standalone"},
        "pid":7,"port":1234,"project_path":"/tmp/project","session_id":SESSION,
        "started_at":"2024-01-01T00:00:00Z"
    });
    let (seen, result) = call(
        StatusCode::OK,
        health_body,
        |c| async move { c.health().await },
    )
    .await;
    assert_request(&seen, "GET", "/health", None);
    assert_eq!(
        result.data.expect("typed health response").session_id,
        SESSION
    );
    executed.insert("health");

    let (seen, result) = call(
        StatusCode::OK,
        json!({}),
        |c| async move { c.terminate().await },
    )
    .await;
    assert_request(&seen, "POST", "/terminate", None);
    assert!(result.is_ok());
    executed.insert("terminate");

    let claim_body = json!({"expires_after_seconds":30,"expires_at":"2099-01-01T00:00:00Z","heartbeat_interval_seconds":1,"lease_id":"lease with space"});
    let seen = lease_lifecycle(claim_body).await;
    assert!(
        seen.iter()
            .any(|r| r.method == "POST" && r.path == "/tui-attachment/claim")
    );
    assert!(
        seen.iter()
            .any(|r| r.method == "POST" && r.path == "/tui-attachment/heartbeat")
    );
    assert!(
        seen.iter()
            .any(|r| r.method == "DELETE" && r.path == "/tui-attachment/lease%20with%20space")
    );
    assert!(
        seen.iter()
            .all(|r| r.auth.as_deref() == Some(format!("Bearer {TOKEN}").as_str()))
    );
    executed.insert("claim_lease");
    executed.insert("heartbeat");
    executed.insert("release_lease");

    let state_body = json!({"active_facet":"default","env":{},"flags":[],"plugin_config":{},"todos":[],"session_id":SESSION});
    let (seen, result) = call(
        StatusCode::OK,
        state_body,
        |c| async move { c.state().await },
    )
    .await;
    assert_request(&seen, "GET", "/state", None);
    assert_eq!(
        result.data.expect("typed state response").active_facet,
        "default"
    );
    executed.insert("state");

    let history_body = json!({"history_revision":2,"items":[{"type":"user","content":"hello"}],"limit":3,"offset":2,"session_id":SESSION,"total_projected_items":4});
    let (seen, result) = call(StatusCode::OK, history_body, |c| async move {
        c.history(Some(2), Some(3)).await
    })
    .await;
    assert_request(&seen, "GET", "/history?offset=2&limit=3", None);
    assert_eq!(result.data.expect("typed history response").offset, 2);
    executed.insert("history");

    let files_body = json!({"files":["src/main.rs"]});
    let (seen, result) = call(StatusCode::OK, files_body.clone(), |c| async move {
        c.files(Some(true)).await
    })
    .await;
    assert_request(&seen, "GET", "/files?include_ignored=true", None);
    assert_eq!(
        result.data.expect("typed files response").files,
        vec!["src/main.rs"]
    );
    executed.insert("files");

    let (seen, result) = call(StatusCode::OK, files_body, |c| async move {
        c.file_catalog().await
    })
    .await;
    assert_request(&seen, "GET", "/files", None);
    assert_eq!(
        result.data.expect("typed file catalog response").files,
        vec!["src/main.rs"]
    );
    executed.insert("file_catalog");

    let jobs_body = json!([]);
    let (seen, result) = call(StatusCode::OK, jobs_body, |c| async move { c.jobs().await }).await;
    assert_request(&seen, "GET", "/jobs", None);
    assert!(result.data.expect("typed jobs response").is_empty());
    executed.insert("jobs");

    let (seen, result) = call(
        StatusCode::OK,
        json!({}),
        |c| async move { c.clear().await },
    )
    .await;
    assert_request(&seen, "POST", "/clear", None);
    assert!(result.is_ok());
    executed.insert("clear");
    let (seen, result) = call(StatusCode::NO_CONTENT, json!(null), |c| async move {
        c.goal_pause().await
    })
    .await;
    assert_request(&seen, "POST", "/goal/pause", None);
    assert!(result.is_ok());
    executed.insert("goal_pause");
    let (seen, result) = call(StatusCode::ACCEPTED, json!({}), |c| async move {
        c.compact(Some(&CompactRequest {
            guidance: Some("g".into()),
        }))
        .await
    })
    .await;
    assert_request(&seen, "POST", "/compact", Some(json!({"guidance":"g"})));
    assert!(result.is_ok());
    executed.insert("compact");
    let (seen, result) = call(StatusCode::ACCEPTED, json!({}), |c| async move {
        c.rewind(&RewindRequest {
            domains: vec!["conversation".into()],
            to_message_index: Some(2),
            to_prompt_id: None,
        })
        .await
    })
    .await;
    assert_request(
        &seen,
        "POST",
        "/rewind",
        Some(json!({"domains":["conversation"],"to_message_index":2})),
    );
    assert!(result.is_ok());
    executed.insert("rewind");
    let (seen, result) = call(StatusCode::NO_CONTENT, json!(null), |c| async move {
        c.respond_interrogative("q 1", &InterrogativeResponse::Cancel)
            .await
    })
    .await;
    assert_request(
        &seen,
        "POST",
        "/interrogative/q%201/respond",
        Some(json!({"kind":"cancel"})),
    );
    assert!(result.is_ok());
    executed.insert("respond_interrogative");
    let (seen, result) = call(StatusCode::OK, json!({"enabled":true}), |c| async move {
        c.toggle_adventurous_handoff().await
    })
    .await;
    assert_request(&seen, "POST", "/adventurous-handoff", None);
    assert_eq!(result.expect("typed toggle response"), true);
    executed.insert("toggle_adventurous_handoff");
    let (seen, result) = call(StatusCode::ACCEPTED, json!({}), |c| async move {
        c.cancel_turn().await
    })
    .await;
    assert_request(&seen, "POST", "/turn/cancel", None);
    assert!(result.is_ok());
    let (seen, result) = call(
        StatusCode::CONFLICT,
        json!({"code":"busy","message":"busy"}),
        |c| async move { c.cancel_turn().await },
    )
    .await;
    assert_request(&seen, "POST", "/turn/cancel", None);
    assert!(result.is_ok(), "409 is an accepted no-op");
    executed.insert("cancel_turn");
    let (seen, result) = call(StatusCode::OK, json!({}), |c| async move {
        c.set_title("title").await
    })
    .await;
    assert_request(&seen, "POST", "/title", Some(json!({"title":"title"})));
    assert!(result.is_ok());
    executed.insert("set_title");
    assert_eq!(
        executed, expected,
        "every expected case must execute exactly once"
    );

    let rejected = json!({"code":"public_code","message":"public message"});
    let (seen, result) = call(StatusCode::UNAUTHORIZED, rejected.clone(), |c| async move {
        c.clear().await
    })
    .await;
    assert_request(&seen, "POST", "/clear", None);
    assert!(result.unwrap_err().contains("public message"));
    let (seen, result) = call(StatusCode::NOT_FOUND, rejected.clone(), |c| async move {
        c.goal_pause().await
    })
    .await;
    assert_request(&seen, "POST", "/goal/pause", None);
    assert!(result.unwrap_err().contains("public message"));
    let (seen, result) = call(StatusCode::CONFLICT, rejected.clone(), |c| async move {
        c.compact(None).await
    })
    .await;
    assert_request(&seen, "POST", "/compact", Some(json!(null)));
    assert!(result.unwrap_err().contains("public message"));
    let (seen, result) = call(
        StatusCode::UNPROCESSABLE_ENTITY,
        rejected.clone(),
        |c| async move {
            c.rewind(&RewindRequest {
                domains: vec!["conversation".into()],
                to_message_index: None,
                to_prompt_id: None,
            })
            .await
        },
    )
    .await;
    assert_request(
        &seen,
        "POST",
        "/rewind",
        Some(json!({"domains":["conversation"]})),
    );
    assert!(result.unwrap_err().contains("public message"));
    let (seen, result) = call(StatusCode::NOT_FOUND, rejected.clone(), |c| async move {
        c.respond_interrogative("q", &InterrogativeResponse::Cancel)
            .await
    })
    .await;
    assert_request(
        &seen,
        "POST",
        "/interrogative/q/respond",
        Some(json!({"kind":"cancel"})),
    );
    assert!(result.unwrap_err().contains("public message"));
    let (seen, result) = call(
        StatusCode::INTERNAL_SERVER_ERROR,
        rejected.clone(),
        |c| async move { c.cancel_turn().await },
    )
    .await;
    assert_request(&seen, "POST", "/turn/cancel", None);
    assert!(result.unwrap_err().contains("public message"));
    let (seen, result) = call(StatusCode::BAD_REQUEST, rejected.clone(), |c| async move {
        c.set_title("title").await
    })
    .await;
    assert_request(&seen, "POST", "/title", Some(json!({"title":"title"})));
    assert!(result.unwrap_err().contains("public message"));

    let (seen, malformed) = call_raw(StatusCode::OK, "not-json".into(), |c| async move {
        c.toggle_adventurous_handoff().await
    })
    .await;
    assert_request(&seen, "POST", "/adventurous-handoff", None);
    assert!(malformed.is_err(), "malformed typed toggle body must fail");
    let (seen, rejected_toggle) = call(StatusCode::FOUND, rejected, |c| async move {
        c.toggle_adventurous_handoff().await
    })
    .await;
    assert_request(&seen, "POST", "/adventurous-handoff", None);
    let toggle_error = rejected_toggle.expect_err("rejected toggle status must fail");
    assert!(toggle_error.contains("public message"));
    assert!(toggle_error.contains("public_code"));

    // Typed response methods must reject malformed success bodies rather than silently
    // presenting an empty/default snapshot, and preserve representative public errors.
    macro_rules! typed_contract {
        ($name:literal, $path:literal, $call:expr) => {{
            let (seen, malformed) = call_raw(StatusCode::OK, "not-json".into(), $call).await;
            assert_request(&seen, "GET", $path, None);
            assert!(malformed.data.is_none(), "malformed $name success must fail decoding");
            let (seen, rejected) = call(StatusCode::INTERNAL_SERVER_ERROR, json!({"code":"public_code","message":"public message"}), $call).await;
            assert_request(&seen, "GET", $path, None);
            assert_eq!(rejected.status, 500);
            assert!(rejected.error.as_deref().unwrap_or_default().contains("public message"));
        }};
    }
    typed_contract!("health", "/health", |c| async move { c.health().await });
    typed_contract!("state", "/state", |c| async move { c.state().await });
    typed_contract!("history", "/history", |c| async move {
        c.history(None, None).await
    });
    typed_contract!("files", "/files", |c| async move { c.files(None).await });
    typed_contract!("jobs", "/jobs", |c| async move { c.jobs().await });
}

#[tokio::test]
async fn daemon_client_auth_matrix() {
    let (seen, result) = call(
        StatusCode::UNAUTHORIZED,
        json!({"code":"unauthorized","message":"denied"}),
        |c| async move { c.clear().await },
    )
    .await;
    assert_request(&seen, "POST", "/clear", None);
    assert!(result.is_err(), "401 must not be accepted");
}

#[test]
fn endpoint_inventory_presence_only_includes_startup_contracts() {
    // Behavioral startup parsing is covered by daemon_client's existing startup tests;
    // this slice only verifies that new/resume remain represented in the inventory.
    assert_eq!(
        pantoken_server::polytoken::endpoint_inventory::STARTUP.len(),
        2
    );
    assert!(
        pantoken_server::polytoken::endpoint_inventory::STARTUP
            .iter()
            .any(|s| s.operation == "new")
    );
    assert!(
        pantoken_server::polytoken::endpoint_inventory::STARTUP
            .iter()
            .any(|s| s.operation == "resume")
    );
}
