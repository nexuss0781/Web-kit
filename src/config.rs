use std::{env, net::SocketAddr};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub api_token: Option<String>,
    pub searxng_url: String,
    pub user_agent: String,
    pub max_body_bytes: usize,
    pub max_redirects: usize,
    pub request_timeout_ms: u64,
}

impl Config {
    pub fn from_env() -> Self {
        let bind_addr = env::var("WEBKIT_BIND_ADDR")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| "0.0.0.0:8080".parse().expect("valid default bind address"));

        Self {
            bind_addr,
            api_token: env::var("WEBKIT_API_TOKEN").ok().filter(|v| !v.is_empty()),
            searxng_url: env::var("WEBKIT_SEARXNG_URL")
                .unwrap_or_else(|_| "http://searxng:8080".to_string()),
            user_agent: env::var("WEBKIT_USER_AGENT").unwrap_or_else(|_| {
                "Web-Kit/0.1 (+https://github.com/nexus-agents/web-kit)".to_string()
            }),
            max_body_bytes: env::var("WEBKIT_MAX_BODY_BYTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5 * 1024 * 1024),
            max_redirects: env::var("WEBKIT_MAX_REDIRECTS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5),
            request_timeout_ms: env::var("WEBKIT_REQUEST_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(12_000),
        }
    }
}
