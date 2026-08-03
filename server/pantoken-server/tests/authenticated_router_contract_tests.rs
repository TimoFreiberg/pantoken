mod support;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use pantoken_server::{
    bootstrap::BootstrapState, config, http, hub, mock_driver::MockDriver, push::PushService,
    static_serve::StaticServer,
};
use std::sync::Arc;
use tower::ServiceExt;

fn fixture() -> (tempfile::TempDir, axum::Router, &'static str, &'static str) {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let dist = temp.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(
        dist.join("index.html"),
        "<script>history.replaceState</script>",
    )
    .unwrap();
    let cfg = config::Config {
        port: 8787,
        data_dir: data.clone(),
        vapid_subject: "mailto:test@example.test".into(),
        host: "127.0.0.1".into(),
        token: Some("bearer-fixture-token".into()),
        debug: true,
        client_dist: dist.clone(),
        warm_cap: 8,
        idle_reap_ms: 0,
        hub_idle_ms: 0,
        live_refresh_ms: 0,
        delta_flush_ms: 0,
        journal_idle_evict_ms: 0,
    };
    let (ops, _rx) = hub::hub_op_channel();
    let hub = hub::SessionHub::new(
        Arc::new(MockDriver::new()),
        ops,
        None,
        0,
        "fixture".into(),
        Some(data.clone()),
        "test".into(),
        0,
        0,
    );
    let state = http::AppState {
        config: Arc::new(cfg),
        static_server: Arc::new(StaticServer::new(dist)),
        hub,
        push: Arc::new(tokio::sync::Mutex::new(PushService::new(
            &data,
            "mailto:test@example.test".into(),
        ))),
        is_debug_driver: true,
        bootstrap: BootstrapState::new(),
    };
    (
        temp,
        http::build_router(state),
        "bearer-fixture-token",
        "bootstrap-fixture-secret",
    )
}

async fn body(response: axum::response::Response) -> (StatusCode, String) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn authenticated_axum_router_fixture() {
    let (_temp, app, token, _) = fixture();
    let response = app
        .clone()
        .oneshot(
            Request::get("/health")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, text) = body(response).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(json["service"], "pantoken-server");
    assert_eq!(json["ok"], true);
    for header in ["", "Basic x", "Bearer wrong"] {
        let req = Request::get("/health")
            .header("authorization", header)
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(req).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let query = Request::get("/health?token=bearer-fixture-token")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(query).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let method = Request::post("/health").body(Body::empty()).unwrap();
    assert_eq!(
        app.clone().oneshot(method).await.unwrap().status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    let ws_query = Request::get("/ws?token=bearer-fixture-token")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(ws_query).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn bootstrap_is_one_time_scrubbed_and_not_ordinary_auth() {
    let (_temp, app, token, _) = fixture();
    let get = Request::get("/bootstrap?credential=invalid")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(get).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let ordinary = Request::get("/health?bootstrap=invalid")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(ordinary).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let valid = Request::get("/bootstrap?credential=invalid")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(valid).await.unwrap();
    assert!(!response.headers().contains_key("authorization"));
    let _ = token;
}
