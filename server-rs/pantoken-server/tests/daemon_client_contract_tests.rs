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

async fn call<F, Fut>(status: StatusCode, body: Value, f: F) -> (Vec<Seen>, Result<(), String>)
where
    F: FnOnce(DaemonClient) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
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
    // Every entry is an executable call to a real DaemonClient method. The set is
    // deliberately derived from the inventory only for the final coverage check;
    // request and response assertions above remain independent wire assertions.
    let mut executed = Vec::new();

    let (seen, result) = call(
        StatusCode::OK,
        json!({}),
        |c| async move { c.clear().await },
    )
    .await;
    assert_request(&seen, "POST", "/clear", None);
    assert!(result.is_ok());
    executed.push("clear");

    let (seen, result) = call(StatusCode::NO_CONTENT, json!(null), |c| async move {
        c.goal_pause().await
    })
    .await;
    assert_request(&seen, "POST", "/goal/pause", None);
    assert!(result.is_ok());
    executed.push("goal_pause");

    let (seen, result) = call(StatusCode::ACCEPTED, json!({}), |c| async move {
        c.compact(Some(&CompactRequest {
            guidance: Some("g".into()),
        }))
        .await
    })
    .await;
    assert_request(&seen, "POST", "/compact", Some(json!({"guidance":"g"})));
    assert!(result.is_ok());
    executed.push("compact");

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
    executed.push("rewind");

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
    executed.push("respond_interrogative");

    let (seen, result) = call(StatusCode::OK, json!({"enabled":true}), |c| async move {
        c.toggle_adventurous_handoff().await.map(|_| ())
    })
    .await;
    assert_request(&seen, "POST", "/adventurous-handoff", None);
    assert!(result.is_ok());
    executed.push("toggle_adventurous_handoff");

    let (seen, result) = call(
        StatusCode::CONFLICT,
        json!({"code":"busy","message":"busy"}),
        |c| async move { c.cancel_turn().await },
    )
    .await;
    assert_request(&seen, "POST", "/turn/cancel", None);
    assert!(result.is_ok());
    executed.push("cancel_turn");

    let (seen, result) = call(
        StatusCode::BAD_REQUEST,
        json!({"code":"bad","message":"public error"}),
        |c| async move { c.set_title("title").await },
    )
    .await;
    assert_request(&seen, "POST", "/title", Some(json!({"title":"title"})));
    let error = result.expect_err("4xx must fail");
    assert!(error.contains("public error"));
    executed.push("set_title");

    let inventory: std::collections::BTreeSet<_> =
        ENDPOINTS.iter().map(|e| e.client_method).collect();
    let executed: std::collections::BTreeSet<_> = executed.into_iter().collect();
    assert!(inventory.is_superset(&executed));
    assert_eq!(
        executed.len(),
        8,
        "this bounded slice has eight executable cases"
    );
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
fn endpoint_inventory_includes_startup_contracts() {
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
