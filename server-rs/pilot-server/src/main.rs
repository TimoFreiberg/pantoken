//! Pilot server binary (Rust port of `server/src/index.ts`).
//!
//! Axum-based WS bridge + HTTP routes + static serving.

pub mod config;
pub mod driver;
pub mod hub;
pub mod journal;
pub mod pidlock;
pub mod settings_store;
pub mod static_serve;
pub mod ws_send;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tracing::{error, info};

/// Shared app state.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub static_server: Arc<static_serve::StaticServer>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = config::load();

    // Mint stable per-data-dir identity before anything else touches the data dir.
    let server_id = match pidlock::mint_or_read_server_id(&cfg.data_dir) {
        Ok(id) => id,
        Err(e) => {
            error!("failed to mint server id: {e}");
            std::process::exit(1);
        }
    };

    // Acquire the single-server lock BEFORE any store opens the data dir.
    let _pid_lock =
        match pidlock::acquire_pid_lock(&cfg.data_dir, &server_id, std::process::id() as i64) {
            Ok(lock) => lock,
            Err(e) => {
                error!(
                    "startup aborted — data dir already locked: pid={} dir={} path={}",
                    e.pid,
                    e.data_dir.display(),
                    e.lock_path.display()
                );
                error!("{}", e);
                std::process::exit(1);
            }
        };

    let static_server = Arc::new(static_serve::StaticServer::new(cfg.client_dist.clone()));
    let state = AppState {
        config: Arc::new(cfg.clone()),
        static_server,
    };

    let app = build_router(state.clone());

    let addr = format!("{}:{}", cfg.host, cfg.port);
    let addr: SocketAddr = addr
        .parse()
        .unwrap_or_else(|e| panic!("failed to parse bind address {addr}: {e}"));

    info!("pilot server (rust) listening on {addr}");
    info!(
        "data dir: {}, driver: {}, token: {}, debug: {}",
        cfg.data_dir.display(),
        std::env::var("PILOT_DRIVER").unwrap_or_else(|_| "polytoken".into()),
        if cfg.token.is_some() { "required" } else { "off" },
        cfg.debug,
    );

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(health))
        .route("/push/vapid", get(push_vapid))
        .route("/push/subscribe", post(push_subscribe))
        .route("/push/unsubscribe", post(push_unsubscribe))
        .route("/push/test", post(push_test))
        .route("/update/state", post(update_state))
        .route("/debug/state", get(debug_state))
        .route("/debug/reset", post(debug_reset))
        .fallback(static_fallback)
        .with_state(state)
}

// ── /health ─────────────────────────────────────────────────────────────

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true }))
}

// ── /ws ─────────────────────────────────────────────────────────────────

async fn ws_handler(ws: WebSocketUpgrade, State(_state): State<AppState>) -> Response {
    ws.on_upgrade(handle_ws_connection)
}

async fn handle_ws_connection(mut ws: WebSocket) {
    // The client sends a hello immediately on open. Until then, messages are
    // rejected. For now this is a minimal echo — the hub (Phase 3) will replace it.
    while let Some(Ok(msg)) = ws.recv().await {
        match msg {
            Message::Text(text) => {
                // Parse as ClientMessage — the hub will handle this in Phase 3.
                // For now, respond to hello with a minimal hello back.
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                    if parsed.get("type").and_then(|t| t.as_str()) == Some("hello") {
                        let hello = json!({
                            "type": "hello",
                            "protocolVersion": 2,
                            "serverId": "rust-pilot",
                            "dataDir": "/tmp/pilot",
                        });
                        let _ = ws_send::send_json(&mut ws, &hello, None).await;
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

// ── /push/* ─────────────────────────────────────────────────────────────

fn check_token(state: &AppState, headers: &HeaderMap, query: &PushQuery) -> bool {
    let auth_header = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    let provided = config::token_from_request(auth_header, query.token.as_deref());
    config::token_ok(provided.as_deref(), &state.config)
}

#[derive(Deserialize)]
struct PushQuery {
    token: Option<String>,
}

async fn push_vapid(State(_state): State<AppState>, Query(_q): Query<PushQuery>) -> Response {
    // TODO Phase 6: wire up PushService
    Json(json!({ "publicKey": "" })).into_response()
}

async fn push_subscribe(State(state): State<AppState>, Query(q): Query<PushQuery>) -> Response {
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // TODO Phase 6: push.add(subscription)
    Json(json!({ "ok": true })).into_response()
}

async fn push_unsubscribe(State(state): State<AppState>, Query(q): Query<PushQuery>) -> Response {
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // TODO Phase 6: push.remove(endpoint)
    Json(json!({ "ok": true })).into_response()
}

async fn push_test(State(state): State<AppState>, Query(q): Query<PushQuery>) -> Response {
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // TODO Phase 6: push.sendToAll(...)
    Json(json!({ "ok": true, "subscriptions": 0, "sent": 0 })).into_response()
}

// ── /update/state ────────────────────────────────────────────────────────

async fn update_state(State(state): State<AppState>, Query(q): Query<PushQuery>) -> Response {
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // TODO Phase 3: hub.reportUpdate(...)
    Json(json!({ "applying": false, "force": false })).into_response()
}

// ── /debug/* ────────────────────────────────────────────────────────────

async fn debug_state(State(state): State<AppState>, Query(q): Query<PushQuery>) -> Response {
    if !state.config.debug {
        return (StatusCode::NOT_FOUND, "debug disabled").into_response();
    }
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // TODO Phase 3: hub.snapshot()
    Json(json!({})).into_response()
}

async fn debug_reset(State(state): State<AppState>, Query(q): Query<PushQuery>) -> Response {
    if !state.config.debug {
        return (StatusCode::NOT_FOUND, "debug disabled").into_response();
    }
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // TODO Phase 3: hub.reset() — mock-only
    Json(json!({ "ok": true })).into_response()
}

// ── static fallback ─────────────────────────────────────────────────────

async fn static_fallback(
    State(state): State<AppState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
) -> Response {
    match state.static_server.serve(uri.path(), &headers).await {
        Ok(resp) => resp,
        Err(()) => (StatusCode::OK, "pilot server — no client build (run `bun run dev`)")
            .into_response(),
    }
}

// ── shutdown ────────────────────────────────────────────────────────────

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("shutdown signal received");
}
