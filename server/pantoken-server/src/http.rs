//! Production HTTP/WebSocket router and authentication boundary.
use crate::connection::{ConnectionSession, SessionEnv};
use crate::{
    config,
    hub::SessionHub,
    push::{PushNotification, PushService, PushSubscription},
    static_serve,
};
use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use parking_lot::Mutex as ParkingMutex;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

/// Shared state for the production HTTP router.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub static_server: Arc<static_serve::StaticServer>,
    pub hub: Arc<ParkingMutex<SessionHub>>,
    pub push: Arc<AsyncMutex<PushService>>,
    pub is_debug_driver: bool,
    pub bootstrap: crate::bootstrap::BootstrapState,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(health))
        .route("/bootstrap", any(bootstrap_method))
        .route("/push/vapid", get(push_vapid))
        .route("/push/subscribe", post(push_subscribe))
        .route("/push/unsubscribe", post(push_unsubscribe))
        .route("/push/test", post(push_test))
        .route("/update/state", post(update_state))
        .route("/update/permit/consume", post(consume_update_permit))
        .route("/debug/state", get(debug_state))
        .route("/debug/reset", get(debug_reset).post(debug_reset))
        .fallback(static_fallback)
        .with_state(state)
}

// ── /bootstrap ──────────────────────────────────────────────────────────

fn bootstrap_unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        Json(json!({ "error": "unauthorized" })),
    )
        .into_response()
}

fn bootstrap_headers() -> axum::http::HeaderMap {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    headers.insert(
        axum::http::header::REFERRER_POLICY,
        axum::http::HeaderValue::from_static("no-referrer"),
    );
    headers
}

async fn bootstrap_method(
    method: axum::http::Method,
    State(state): State<AppState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    match method {
        axum::http::Method::GET => {
            let Some(credential) = query.get("credential") else {
                return bootstrap_unauthorized();
            };
            if !state.bootstrap.valid(credential).await {
                return bootstrap_unauthorized();
            }
            let page = r#"<!doctype html><meta name="referrer" content="no-referrer"><title>Pantoken setup</title><p>Connecting…</p><script>(()=>{const u=new URL(location.href),c=u.searchParams.get("credential");history.replaceState(null,"",u.pathname+u.hash);fetch("/bootstrap",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({credential:c})}).then(r=>r.ok?r.json():Promise.reject()).then(({token})=>{if(token)location.replace("/")}).catch(()=>{document.body.textContent="This setup link is invalid or expired."})})()</script>"#;
            let mut response = (StatusCode::OK, page).into_response();
            *response.headers_mut() = bootstrap_headers();
            response.headers_mut().insert(
                axum::http::header::CONTENT_TYPE,
                axum::http::HeaderValue::from_static("text/html; charset=utf-8"),
            );
            response
        }
        axum::http::Method::POST => {
            bootstrap_post_inner(State(state), headers, Query(query), body).await
        }
        _ => {
            let mut response = (
                StatusCode::METHOD_NOT_ALLOWED,
                Json(json!({ "error": "method_not_allowed" })),
            )
                .into_response();
            response.headers_mut().insert(
                axum::http::header::ALLOW,
                axum::http::HeaderValue::from_static("GET, POST"),
            );
            response
        }
    }
}

async fn bootstrap_post_inner(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
    body: String,
) -> Response {
    if !query.is_empty()
        || headers
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            != Some("application/json")
    {
        return bootstrap_unauthorized();
    }
    let Ok(request) = serde_json::from_str::<crate::bootstrap::ExchangeRequest>(&body) else {
        return bootstrap_unauthorized();
    };
    let Some(credential) = request.credential.filter(|value| !value.is_empty()) else {
        return bootstrap_unauthorized();
    };
    if !state.bootstrap.consume(&credential).await {
        return bootstrap_unauthorized();
    }
    let Some(token) = state.config.token.as_ref() else {
        return bootstrap_unauthorized();
    };
    let mut response = (StatusCode::OK, Json(json!({ "token": token }))).into_response();
    let headers = bootstrap_headers();
    response.headers_mut().extend(headers);
    response
}

// ── /health ─────────────────────────────────────────────────────────────

async fn health(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let hub = state.hub.lock();
    let activity = hub.activity();
    Json(json!({
        "service": "pantoken-server",
        "ok": true,
        "clients": hub.client_count(),
        "running": activity["running"],
        "initializing": activity["initializing"],
        "busy": activity["busy"],
    }))
    .into_response()
}

// ── /ws ─────────────────────────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<PushQuery>,
) -> Response {
    // Browser WebSocket clients cannot reliably set Authorization headers. The
    // first Hello frame is the credential gate; query credentials are never
    // accepted and are rejected before the upgrade completes.
    if query.token.is_some() {
        return unauthorized();
    }
    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(ws: WebSocket, state: AppState) {
    use crate::connection::ws::WsAdapter;

    let env = SessionEnv {
        hub: state.hub.clone(),
        config: state.config.clone(),
    };
    let adapter = WsAdapter::new(ws);
    ConnectionSession::new(adapter, env).run().await;
}

// ── /push/* ─────────────────────────────────────────────────────────────

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    config::token_ok(config::bearer_from_headers(headers), &state.config)
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

fn check_token(state: &AppState, headers: &HeaderMap, _query: &PushQuery) -> bool {
    authorized(state, headers)
}

#[derive(Deserialize)]
struct PushQuery {
    token: Option<String>,
    bootstrap: Option<String>,
}

/// Body of POST /push/unsubscribe — just the endpoint to drop.
#[derive(Deserialize)]
struct UnsubscribeBody {
    endpoint: Option<String>,
}

async fn push_vapid(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
) -> Response {
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let push = state.push.lock().await;
    Json(json!({ "publicKey": push.public_key() })).into_response()
}

async fn push_subscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
    body: String,
) -> Response {
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // C3: parse the body manually so a malformed JSON body returns 400 (matching
    // TS `bad request`) rather than axum's default 422 from the `Json` extractor.
    let sub: PushSubscription = match serde_json::from_str(&body) {
        Ok(s) => s,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad request").into_response(),
    };
    let mut push = state.push.lock().await;
    push.add(sub);
    Json(json!({ "ok": true })).into_response()
}

async fn push_unsubscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
    body: String,
) -> Response {
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // C3: manual parse → 400 on malformed body (not axum's 422).
    let parsed: UnsubscribeBody = match serde_json::from_str(&body) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad request").into_response(),
    };
    let mut push = state.push.lock().await;
    if let Some(endpoint) = parsed.endpoint {
        push.remove(&endpoint);
    }
    Json(json!({ "ok": true })).into_response()
}

async fn push_test(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
) -> Response {
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // C4: capture `count` inside the same lock scope as `send_to_all` so the
    // returned `subscriptions` reflects the count at send time (a separate
    // lock could observe a different count if a (un)subscribe raced in between).
    let (sent, count) = {
        let mut push = state.push.lock().await;
        let sent = push
            .send_to_all(&PushNotification {
                title: "pantoken".into(),
                body: "Test push ✅ — if you see this on a closed phone, it works.".into(),
                tag: Some("pantoken-test".into()),
                url: None,
                // A visible non-zero badge, so the test push also proves the
                // Badging API path on-device (cleared on next app focus).
                badge: Some(1),
            })
            .await;
        (sent, push.count())
    };
    Json(json!({ "ok": true, "subscriptions": count, "sent": sent })).into_response()
}

// ── /update/state ────────────────────────────────────────────────────────

/// Body of POST /update/state — the shell updater's staged-update report.
/// Mirrors the TS handler (server/src/index.ts:303): `available` gates whether
/// `sha` is honored; `applyFailed` resets a stuck "applying" card.
#[derive(Deserialize)]
struct UpdateStateBody {
    available: Option<bool>,
    sha: Option<String>,
    #[serde(rename = "applyFailed")]
    apply_failed: Option<bool>,
}

async fn update_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
    Json(body): Json<UpdateStateBody>,
) -> Response {
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let sha = if body.available.unwrap_or(false) {
        body.sha
    } else {
        None
    };
    let apply_failed = body.apply_failed.unwrap_or(false);
    let mut hub = state.hub.lock();
    let result = hub.report_update(sha, apply_failed, None);
    Json(result).into_response()
}

#[derive(Deserialize)]
struct ConsumePermitBody {
    #[serde(rename = "authorizationGeneration")]
    authorization_generation: u64,
    #[serde(rename = "leaseNonce")]
    lease_nonce: String,
    #[serde(rename = "leaseSha")]
    lease_sha: String,
}

async fn consume_update_permit(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<ConsumePermitBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if !authorized(&state, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"permit": false, "reason": "unauthorized"})),
        )
            .into_response();
    }
    let Ok(Json(body)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"permit": false, "reason": "malformed"})),
        )
            .into_response();
    };
    let mut hub = state.hub.lock();
    match hub.consume_update_permit(
        body.authorization_generation,
        &body.lease_nonce,
        &body.lease_sha,
    ) {
        Ok(()) => Json(json!({"permit": true})).into_response(),
        Err(reason) => Json(json!({"permit": false, "reason": reason})).into_response(),
    }
}

// ── /debug/* ────────────────────────────────────────────────────────────

async fn debug_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
) -> Response {
    if !state.config.debug {
        return (StatusCode::NOT_FOUND, "debug disabled").into_response();
    }
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let hub = state.hub.lock();
    Json(hub.snapshot()).into_response()
}

async fn debug_reset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
) -> Response {
    if !state.config.debug {
        return (StatusCode::NOT_FOUND, "debug disabled").into_response();
    }
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    if !state.is_debug_driver {
        return (StatusCode::FORBIDDEN, "debug reset is dev-driver-only").into_response();
    }
    let bootstrap = q.bootstrap.as_deref() != Some("0");
    let mut hub = state.hub.lock();
    hub.reset(bootstrap);
    Json(json!({ "ok": true })).into_response()
}

// ── static fallback ─────────────────────────────────────────────────────

async fn static_fallback(
    State(state): State<AppState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state.static_server.serve(uri.path(), &headers).await {
        Ok(resp) => resp,
        Err(()) => (
            StatusCode::OK,
            "pantoken server — no client build (run `bun run dev`)",
        )
            .into_response(),
    }
}
