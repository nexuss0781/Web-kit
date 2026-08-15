use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    pub providers: Option<Vec<String>>,
    pub mode: Option<SearchMode>,
    pub limit: Option<usize>,
    pub language: Option<String>,
    pub safe_search: Option<String>,
    pub time_range: Option<String>,
    pub domains: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    Single,
    Fallback,
    Fanout,
}

impl Default for SearchMode {
    fn default() -> Self {
        Self::Fanout
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub request_id: String,
    pub query: String,
    pub mode: SearchMode,
    pub results: Vec<SearchResult>,
    pub providers: HashMap<String, ProviderStatus>,
    pub warnings: Vec<String>,
    pub timing: Timing,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub id: String,
    pub rank: usize,
    pub title: String,
    pub url: String,
    pub canonical_url: Option<String>,
    pub snippet: Option<String>,
    pub providers: Vec<String>,
    pub provider_ranks: HashMap<String, usize>,
    pub score: f64,
    pub content_type: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderStatus {
    pub status: String,
    pub latency_ms: u128,
    pub result_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Timing {
    pub total_ms: u128,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FetchRequest {
    pub url: String,
    pub mode: Option<FetchMode>,
    pub render: Option<RenderMode>,
    pub timeout_ms: Option<u64>,
    pub max_bytes: Option<usize>,
    pub follow_redirects: Option<bool>,
    pub respect_robots: Option<bool>,
    pub include_links: Option<bool>,
    pub include_images: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FetchMode {
    Raw,
    Text,
    Markdown,
    Metadata,
}

impl Default for FetchMode {
    fn default() -> Self {
        Self::Markdown
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderMode {
    Never,
    Auto,
    Always,
}

impl Default for RenderMode {
    fn default() -> Self {
        Self::Never
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FetchResponse {
    pub request_id: String,
    pub retrieval: RetrievalMetadata,
    pub document: Document,
    pub warnings: Vec<String>,
    pub timing: Timing,
}

#[derive(Debug, Clone, Serialize)]
pub struct RetrievalMetadata {
    pub requested_url: String,
    pub final_url: String,
    pub status_code: u16,
    pub content_type: Option<String>,
    pub content_length: usize,
    pub redirects: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Document {
    pub title: Option<String>,
    pub description: Option<String>,
    pub canonical_url: Option<String>,
    pub language: Option<String>,
    pub text: Option<String>,
    pub markdown: Option<String>,
    pub html: Option<String>,
    pub links: Vec<String>,
    pub images: Vec<String>,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderInfo {
    pub id: String,
    pub kind: String,
    pub enabled: bool,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub message: String,
    pub request_id: String,
}
