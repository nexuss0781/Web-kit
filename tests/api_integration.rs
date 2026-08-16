use axum::{
    extract::{Query, State},
    http::{header, Method, Request, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::net::TcpListener;
use tower::ServiceExt;
use web_kit::{build_app, config::Config};

#[derive(Clone, Default)]
struct MockState {
    calls: Arc<Mutex<Vec<HashMap<String, String>>>>,
}

async fn mock_search(
    State(state): State<MockState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    state.calls.lock().unwrap().push(params.clone());
    if params.get("engines").map(String::as_str) == Some("duckduckgo") {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": "fixture provider failure"})),
        );
    }

    let engine = params
        .get("engines")
        .cloned()
        .unwrap_or_else(|| "searxng".to_string());
    let results = vec![
        json!({
            "title": "Example documentation",
            "url": "https://example.org/docs?utm_source=fixture#intro",
            "content": "Deterministic documentation result",
            "publishedDate": "2026-01-02"
        }),
        json!({
            "title": format!("{engine} second result"),
            "url": format!("https://{engine}.example.org/result"),
            "content": "Another deterministic result"
        }),
    ];
    (StatusCode::OK, Json(json!({"results": results})))
}

async fn spawn_search_fixture() -> (String, MockState) {
    let state = MockState::default();
    let app = Router::new()
        .route("/search", get(mock_search))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{}", address), state)
}

fn test_config(searxng_url: String, api_token: Option<&str>) -> Config {
    Config {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        api_token: api_token.map(str::to_owned),
        searxng_url,
        user_agent: "Web-Kit-test/1.0".to_string(),
        max_body_bytes: 1024,
        max_redirects: 2,
        request_timeout_ms: 1000,
    }
}

async fn call(
    app: &Router,
    method: Method,
    uri: &str,
    auth: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(token) = auth {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let request = if let Some(body) = body {
        request
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap()
    } else {
        request.body(axum::body::Body::empty()).unwrap()
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&bytes)}));
    (status, value)
}

#[tokio::test]
async fn public_health_and_readiness_endpoints_work_without_authentication() {
    let (base_url, _) = spawn_search_fixture().await;
    let app = build_app(test_config(base_url, Some("secret")));

    let (status, health) = call(&app, Method::GET, "/healthz", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["status"], "ok");
    assert_eq!(health["service"], "web-kit");

    let (status, ready) = call(&app, Method::GET, "/readyz", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ready["status"], "ready");
    assert_eq!(ready["providers"].as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn protected_routes_require_a_valid_bearer_token() {
    let (base_url, _) = spawn_search_fixture().await;
    let app = build_app(test_config(base_url, Some("secret")));

    for (method, uri, body) in [
        (Method::GET, "/v1/providers", None),
        (Method::GET, "/v1/search?q=docs", None),
        (Method::POST, "/v1/search", Some(json!({"query": "docs"}))),
        (
            Method::POST,
            "/v1/fetch",
            Some(json!({"url": "http://127.0.0.1/"})),
        ),
    ] {
        let (status, error) = call(&app, method.clone(), uri, None, body.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        assert_eq!(error["error"], "unauthorized");
        assert!(error["request_id"].as_str().unwrap().len() > 10);
    }

    let (status, _) = call(&app, Method::GET, "/v1/providers", Some("wrong"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, providers) = call(&app, Method::GET, "/v1/providers", Some("secret"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(providers.as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn provider_listing_is_sorted_and_exposes_capabilities() {
    let (base_url, _) = spawn_search_fixture().await;
    let app = build_app(test_config(base_url, Some("secret")));
    let (status, providers) = call(&app, Method::GET, "/v1/providers", Some("secret"), None).await;
    assert_eq!(status, StatusCode::OK);

    let providers = providers.as_array().unwrap();
    let ids: Vec<_> = providers
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec!["brave", "duckduckgo", "mojeek", "qwant", "searxng"]
    );
    assert!(providers.iter().all(|p| p["enabled"] == true));
    assert!(providers.iter().all(|p| p["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("json"))));
}

#[tokio::test]
async fn search_post_fanout_deduplicates_results_and_keeps_provenance() {
    let (base_url, fixture) = spawn_search_fixture().await;
    let app = build_app(test_config(base_url, Some("secret")));
    let request = json!({
        "query": "Rust documentation",
        "providers": ["mojeek", "qwant"],
        "mode": "fanout",
        "limit": 10,
        "language": "en",
        "safe_search": "1",
        "time_range": "week",
        "domains": ["docs.rs"]
    });

    let (status, response) = call(
        &app,
        Method::POST,
        "/v1/search",
        Some("secret"),
        Some(request),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["query"], "Rust documentation");
    assert_eq!(response["mode"], "fanout");
    assert_eq!(response["results"].as_array().unwrap().len(), 3);

    let first = &response["results"][0];
    assert_eq!(first["canonical_url"], "https://example.org/docs");
    assert_eq!(first["providers"].as_array().unwrap().len(), 2);
    assert_eq!(first["provider_ranks"]["mojeek"], 1);
    assert_eq!(first["provider_ranks"]["qwant"], 1);
    assert!(first["id"].as_str().unwrap().starts_with("wk_"));
    assert_eq!(response["providers"]["mojeek"]["status"], "ok");
    assert_eq!(response["providers"]["qwant"]["status"], "ok");

    let calls = fixture.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert!(calls
        .iter()
        .all(|params| params["q"].contains("site:docs.rs")));
    assert!(calls.iter().all(|params| params["language"] == "en"));
    assert!(calls.iter().all(|params| params["safesearch"] == "1"));
    assert!(calls.iter().all(|params| params["time_range"] == "week"));
}

#[tokio::test]
async fn search_get_supports_aliases_filters_and_limit() {
    let (base_url, fixture) = spawn_search_fixture().await;
    let app = build_app(test_config(base_url, Some("secret")));
    let uri = "/v1/search?q=docs&providers=mojeek&mode=single&limit=1&language=en&domains=docs.rs,example.org";
    let (status, response) = call(&app, Method::GET, uri, Some("secret"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["mode"], "single");
    assert_eq!(response["results"].as_array().unwrap().len(), 1);
    assert_eq!(response["providers"]["mojeek"]["status"], "ok");
    let calls = fixture.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert!(calls[0]["q"].contains("site:docs.rs"));
    assert!(calls[0]["q"].contains("site:example.org"));
}

#[tokio::test]
async fn search_fallback_skips_failure_and_uses_next_provider() {
    let (base_url, _) = spawn_search_fixture().await;
    let app = build_app(test_config(base_url, Some("secret")));
    let request = json!({
        "query": "fallback test",
        "providers": ["duckduckgo", "qwant"],
        "mode": "fallback"
    });
    let (status, response) = call(
        &app,
        Method::POST,
        "/v1/search",
        Some("secret"),
        Some(request),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["providers"]["duckduckgo"]["status"], "error");
    assert_eq!(response["providers"]["qwant"]["status"], "ok");
    assert!(!response["results"].as_array().unwrap().is_empty());
    assert_eq!(response["warnings"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn invalid_search_requests_return_structured_400_errors() {
    let (base_url, _) = spawn_search_fixture().await;
    let app = build_app(test_config(base_url, Some("secret")));

    let (status, missing) = call(&app, Method::GET, "/v1/search", Some("secret"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(missing["error"], "invalid_request");

    let (status, empty) = call(
        &app,
        Method::POST,
        "/v1/search",
        Some("secret"),
        Some(json!({"query": "   "})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(empty["message"].as_str().unwrap().contains("1-1000"));

    let (status, too_long) = call(
        &app,
        Method::POST,
        "/v1/search",
        Some("secret"),
        Some(json!({"query": "x".repeat(1001)})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(too_long["error"], "invalid_request");
}

#[tokio::test]
async fn fetch_api_blocks_ssrf_targets_and_oversized_urls() {
    let (base_url, _) = spawn_search_fixture().await;
    let app = build_app(test_config(base_url, Some("secret")));

    for url in [
        "http://127.0.0.1/",
        "http://localhost/",
        "http://10.0.0.1/",
        "file:///etc/passwd",
        "https://user:password@example.org/",
    ] {
        let (status, response) = call(
            &app,
            Method::POST,
            "/v1/fetch",
            Some("secret"),
            Some(json!({"url": url, "mode": "metadata"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{url}");
        assert_eq!(response["error"], "fetch_failed");
    }

    let oversized_url = format!("https://example.org/{}", "x".repeat(4100));
    let (status, response) = call(
        &app,
        Method::POST,
        "/v1/fetch",
        Some("secret"),
        Some(json!({"url": oversized_url})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(response["error"], "invalid_request");
}

#[tokio::test]
async fn empty_api_token_disables_auth_for_trusted_network_mode() {
    let (base_url, _) = spawn_search_fixture().await;
    let app = build_app(test_config(base_url, None));
    let (status, providers) = call(&app, Method::GET, "/v1/providers", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(providers.as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn fetch_get_parses_url_mode_and_render_query_parameters() {
    let (base_url, _) = spawn_search_fixture().await;
    let app = build_app(test_config(base_url, Some("secret")));
    let uri = "/v1/fetch?url=http%3A%2F%2F127.0.0.1%2F&mode=metadata&render=always";
    let (status, response) = call(&app, Method::GET, uri, Some("secret"), None).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(response["error"], "fetch_failed");
}
