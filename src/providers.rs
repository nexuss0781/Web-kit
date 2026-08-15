use crate::{
    config::Config,
    models::{ProviderInfo, ProviderStatus, SearchMode, SearchRequest, SearchResult},
};
use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc, time::Instant};
use url::Url;

#[derive(Debug, Clone)]
pub struct ProviderResult {
    pub title: String,
    pub url: String,
    pub snippet: Option<String>,
    pub content_type: Option<String>,
    pub published_at: Option<String>,
}

#[async_trait]
pub trait SearchProvider: Send + Sync {
    fn info(&self) -> ProviderInfo;
    async fn search(&self, request: &SearchRequest) -> Result<Vec<ProviderResult>>;
}

pub struct SearxngProvider {
    client: Client,
    base_url: String,
    user_agent: String,
    id: String,
    kind: String,
    engine: Option<String>,
}

impl SearxngProvider {
    pub fn aggregator(client: Client, config: &Config) -> Self {
        Self::new(client, config, "searxng", "self_hosted_metasearch", None)
    }

    pub fn engine(client: Client, config: &Config, id: &str, engine: &str) -> Self {
        Self::new(
            client,
            config,
            id,
            "searxng_engine",
            Some(engine.to_string()),
        )
    }

    fn new(client: Client, config: &Config, id: &str, kind: &str, engine: Option<String>) -> Self {
        Self {
            client,
            base_url: config.searxng_url.trim_end_matches('/').to_string(),
            user_agent: config.user_agent.clone(),
            id: id.to_string(),
            kind: kind.to_string(),
            engine,
        }
    }
}

#[async_trait]
impl SearchProvider for SearxngProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            id: self.id.clone(),
            kind: self.kind.clone(),
            enabled: true,
            capabilities: vec![
                "web".to_string(),
                "news".to_string(),
                "images".to_string(),
                "json".to_string(),
            ],
        }
    }

    async fn search(&self, request: &SearchRequest) -> Result<Vec<ProviderResult>> {
        let query = build_query(request);
        let page = 1usize;
        let endpoint = format!("{}/search", self.base_url);
        let mut params = vec![
            ("q".to_string(), query),
            ("format".to_string(), "json".to_string()),
            ("pageno".to_string(), page.to_string()),
        ];
        if let Some(language) = &request.language {
            params.push(("language".to_string(), language.clone()));
        }
        if let Some(safe_search) = &request.safe_search {
            params.push(("safesearch".to_string(), safe_search.clone()));
        }
        if let Some(time_range) = &request.time_range {
            params.push(("time_range".to_string(), time_range.clone()));
        }
        if let Some(engine) = &self.engine {
            params.push(("engines".to_string(), engine.clone()));
        }

        let response = self
            .client
            .get(endpoint)
            .header(reqwest::header::USER_AGENT, &self.user_agent)
            .query(&params)
            .send()
            .await
            .map_err(|e| anyhow!("SearXNG request failed: {e}"))?;
        if !response.status().is_success() {
            bail!("SearXNG returned HTTP {}", response.status())
        }
        let payload: Value = response
            .json()
            .await
            .map_err(|e| anyhow!("invalid SearXNG JSON: {e}"))?;
        let results = payload
            .get("results")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("SearXNG response did not contain results"))?;

        Ok(results.iter().filter_map(parse_searx_result).collect())
    }
}

fn parse_searx_result(value: &Value) -> Option<ProviderResult> {
    let url = value.get("url")?.as_str()?.to_string();
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(&url)
        .to_string();
    let snippet = value
        .get("content")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let published_at = value
        .get("publishedDate")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some(ProviderResult {
        title,
        url,
        snippet,
        content_type: None,
        published_at,
    })
}

pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn SearchProvider>>,
}

impl ProviderRegistry {
    pub fn new(client: Client, config: &Config) -> Self {
        let mut providers = HashMap::new();
        providers.insert(
            "searxng".to_string(),
            Arc::new(SearxngProvider::aggregator(client.clone(), config))
                as Arc<dyn SearchProvider>,
        );
        for (id, engine) in [
            ("duckduckgo", "duckduckgo"),
            ("mojeek", "mojeek"),
            ("brave", "brave"),
            ("qwant", "qwant"),
        ] {
            providers.insert(
                id.to_string(),
                Arc::new(SearxngProvider::engine(client.clone(), config, id, engine))
                    as Arc<dyn SearchProvider>,
            );
        }
        Self { providers }
    }

    pub fn infos(&self) -> Vec<ProviderInfo> {
        let mut infos: Vec<_> = self.providers.values().map(|p| p.info()).collect();
        infos.sort_by(|a, b| a.id.cmp(&b.id));
        infos
    }

    pub async fn search(
        &self,
        request: &SearchRequest,
    ) -> (
        Vec<SearchResult>,
        HashMap<String, ProviderStatus>,
        Vec<String>,
    ) {
        let started = Instant::now();
        let mode = request.mode.clone().unwrap_or_default();
        let names = request.providers.clone().unwrap_or_else(|| {
            vec![
                "searxng".to_string(),
                "duckduckgo".to_string(),
                "mojeek".to_string(),
                "brave".to_string(),
                "qwant".to_string(),
            ]
        });
        let mut warnings = Vec::new();
        let mut statuses = HashMap::new();
        let mut collected = Vec::new();

        if matches!(mode, SearchMode::Single | SearchMode::Fallback) {
            for name in names {
                let Some(provider) = self.providers.get(&name) else {
                    statuses.insert(
                        name.clone(),
                        ProviderStatus {
                            status: "unknown".to_string(),
                            latency_ms: 0,
                            result_count: 0,
                            error: Some("provider is not configured".to_string()),
                        },
                    );
                    warnings.push(format!("Provider '{name}' is not configured."));
                    continue;
                };
                let started_provider = Instant::now();
                match provider.search(request).await {
                    Ok(results) => {
                        let count = results.len();
                        statuses.insert(
                            name.clone(),
                            ProviderStatus {
                                status: "ok".to_string(),
                                latency_ms: started_provider.elapsed().as_millis(),
                                result_count: count,
                                error: None,
                            },
                        );
                        collected.push((name, results));
                        if matches!(mode, SearchMode::Fallback) {
                            break;
                        }
                    }
                    Err(error) => {
                        statuses.insert(
                            name.clone(),
                            ProviderStatus {
                                status: "error".to_string(),
                                latency_ms: started_provider.elapsed().as_millis(),
                                result_count: 0,
                                error: Some(error.to_string()),
                            },
                        );
                        warnings.push(format!("Provider '{name}' failed: {error}"));
                    }
                }
            }
        } else {
            let futures = names.iter().filter_map(|name| {
                self.providers.get(name).map(|provider| {
                    let provider = Arc::clone(provider);
                    let request = request.clone();
                    let name = name.clone();
                    async move {
                        let started_provider = Instant::now();
                        let result = provider.search(&request).await;
                        (name, started_provider.elapsed().as_millis(), result)
                    }
                })
            });
            for (name, latency_ms, result) in futures_util::future::join_all(futures).await {
                match result {
                    Ok(results) => {
                        let count = results.len();
                        statuses.insert(
                            name.clone(),
                            ProviderStatus {
                                status: "ok".to_string(),
                                latency_ms,
                                result_count: count,
                                error: None,
                            },
                        );
                        collected.push((name, results));
                    }
                    Err(error) => {
                        statuses.insert(
                            name.clone(),
                            ProviderStatus {
                                status: "error".to_string(),
                                latency_ms,
                                result_count: 0,
                                error: Some(error.to_string()),
                            },
                        );
                        warnings.push(format!("Provider '{name}' failed: {error}"));
                    }
                }
            }
        }

        let results = merge_results(collected, request.limit.unwrap_or(10).clamp(1, 100));
        if results.is_empty() && warnings.is_empty() {
            warnings.push("No results were returned by the configured providers.".to_string());
        }
        let _ = started;
        (results, statuses, warnings)
    }
}

fn build_query(request: &SearchRequest) -> String {
    let mut query = request.query.trim().to_string();
    if let Some(domains) = &request.domains {
        for domain in domains.iter().filter(|d| !d.trim().is_empty()).take(20) {
            query.push_str(" site:");
            query.push_str(domain.trim());
        }
    }
    query
}

fn merge_results(groups: Vec<(String, Vec<ProviderResult>)>, limit: usize) -> Vec<SearchResult> {
    let mut by_url: HashMap<String, SearchResult> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let k = 60.0;

    for (provider, results) in groups {
        for (index, item) in results.into_iter().enumerate() {
            let canonical = canonicalize(&item.url);
            if canonical.is_empty() {
                continue;
            }
            let rank = index + 1;
            let contribution = 1.0 / (k + rank as f64);
            if let Some(existing) = by_url.get_mut(&canonical) {
                existing.score += contribution;
                if !existing.providers.contains(&provider) {
                    existing.providers.push(provider.clone());
                }
                existing.provider_ranks.insert(provider.clone(), rank);
                if existing.snippet.is_none() {
                    existing.snippet = item.snippet;
                }
            } else {
                let id = stable_id(&canonical);
                let mut provider_ranks = HashMap::new();
                provider_ranks.insert(provider.clone(), rank);
                by_url.insert(
                    canonical.clone(),
                    SearchResult {
                        id,
                        rank: 0,
                        title: item.title,
                        url: item.url,
                        canonical_url: Some(canonical.clone()),
                        snippet: item.snippet,
                        providers: vec![provider.clone()],
                        provider_ranks,
                        score: contribution,
                        content_type: item.content_type,
                        published_at: item.published_at,
                    },
                );
                order.push(canonical);
            }
        }
    }

    let mut results: Vec<_> = order
        .into_iter()
        .filter_map(|key| by_url.remove(&key))
        .collect();
    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.url.cmp(&b.url))
    });
    results.truncate(limit);
    for (index, result) in results.iter_mut().enumerate() {
        result.rank = index + 1;
    }
    results
}

fn canonicalize(raw: &str) -> String {
    let Ok(mut parsed) = Url::parse(raw) else {
        return String::new();
    };
    parsed.set_fragment(None);
    let remove = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "gclid",
        "fbclid",
    ];
    let kept: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(key, _)| !remove.contains(&key.as_ref()))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let query = kept
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    parsed.set_query(if query.is_empty() { None } else { Some(&query) });
    parsed.to_string().trim_end_matches('/').to_string()
}

fn stable_id(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("wk_{}", &digest[..16])
}

#[cfg(test)]
mod tests {
    use super::canonicalize;

    #[test]
    fn canonicalization_removes_tracking() {
        assert_eq!(
            canonicalize("https://EXAMPLE.org/path/?utm_source=x#section"),
            "https://example.org/path"
        );
    }
}
