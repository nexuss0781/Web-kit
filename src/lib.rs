pub mod config;
pub mod fetcher;
pub mod models;
pub mod providers;
pub mod safety;

use axum::{
    extract::{Query, State},
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use config::Config;
use fetcher::fetch_url;
use models::{ErrorResponse, FetchRequest, SearchRequest};
use providers::ProviderRegistry;
use reqwest::redirect::Policy;
use serde::Deserialize;
use serde_json::json;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tower_http::{
    compression::CompressionLayer, cors::CorsLayer, timeout::TimeoutLayer, trace::TraceLayer,
};
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub client: reqwest::Client,
    pub providers: Arc<ProviderRegistry>,
}

#[derive(Debug, Deserialize)]
struct FetchQuery {
    url: String,
    mode: Option<models::FetchMode>,
    render: Option<models::RenderMode>,
}

pub fn build_app(config: Config) -> Router {
    let config = Arc::new(config);
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .pool_idle_timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("valid HTTP client configuration");
    let providers = Arc::new(ProviderRegistry::new(client.clone(), &config));
    let state = Arc::new(AppState {
        config,
        client,
        providers,
    });

    let public = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz));
    let protected = Router::new()
        .route("/v1/providers", get(list_providers))
        .route("/v1/search", get(search_get).post(search_post))
        .route("/v1/fetch", get(fetch_get).post(fetch_post))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    public
        .merge(protected)
        .with_state(state)
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .layer(TimeoutLayer::new(Duration::from_secs(30)))
        .layer(TraceLayer::new_for_http())
}

async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let Some(expected) = state.config.api_token.as_deref() else {
        return next.run(request).await;
    };

    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|token| token == expected)
        .unwrap_or(false);

    if authorized {
        next.run(request).await
    } else {
        error_response(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid bearer token",
        )
    }
}

async fn healthz() -> impl IntoResponse {
    Json(json!({"status": "ok", "service": "web-kit"}))
}

async fn readyz(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let providers = state.providers.infos();
    Json(json!({"status": "ready", "providers": providers}))
}

async fn list_providers(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.providers.infos())
}

async fn search_post(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SearchRequest>,
) -> Response {
    handle_search(state, request).await
}

async fn search_get(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(term) = query.get("query").or_else(|| query.get("q")) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "query is required",
        );
    };
    let providers = query.get("providers").map(|value| {
        value
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .collect()
    });
    let domains = query.get("domains").map(|value| {
        value
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .collect()
    });
    let mode = query
        .get("mode")
        .and_then(|value| serde_json::from_value(json!(value)).ok());
    let limit = query.get("limit").and_then(|value| value.parse().ok());
    let request = SearchRequest {
        query: term.clone(),
        providers,
        mode,
        limit,
        language: query.get("language").cloned(),
        safe_search: query.get("safe_search").cloned(),
        time_range: query.get("time_range").cloned(),
        domains,
    };
    handle_search(state, request).await
}

async fn handle_search(state: Arc<AppState>, request: SearchRequest) -> Response {
    if request.query.trim().is_empty() || request.query.len() > 1000 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "query must contain 1-1000 characters",
        );
    }
    let request_id = Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let mode = request.mode.clone().unwrap_or_default();
    let (results, providers, warnings) = state.providers.search(&request).await;
    Json(models::SearchResponse {
        request_id,
        query: request.query,
        mode,
        results,
        providers,
        warnings,
        timing: models::Timing {
            total_ms: started.elapsed().as_millis(),
        },
    })
    .into_response()
}

async fn fetch_post(
    State(state): State<Arc<AppState>>,
    Json(request): Json<FetchRequest>,
) -> Response {
    handle_fetch(state, request).await
}

async fn fetch_get(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FetchQuery>,
) -> Response {
    handle_fetch(
        state,
        FetchRequest {
            url: query.url,
            mode: query.mode,
            render: query.render,
            timeout_ms: None,
            max_bytes: None,
            follow_redirects: None,
            respect_robots: None,
            include_links: None,
            include_images: None,
        },
    )
    .await
}

async fn handle_fetch(state: Arc<AppState>, request: FetchRequest) -> Response {
    if request.url.len() > 4096 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "url is too long",
        );
    }
    let request_id = Uuid::new_v4().to_string();
    match fetch_url(
        request,
        state.config.clone(),
        state.client.clone(),
        request_id.clone(),
    )
    .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => error_response(StatusCode::BAD_GATEWAY, "fetch_failed", &error.to_string()),
    }
}

fn error_response(status: StatusCode, error: &str, message: &str) -> Response {
    (
        status,
        Json(ErrorResponse {
            error: error.to_string(),
            message: message.to_string(),
            request_id: Uuid::new_v4().to_string(),
        }),
    )
        .into_response()
}
