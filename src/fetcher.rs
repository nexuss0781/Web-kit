use crate::{
    config::Config,
    models::{
        Document, FetchMode, FetchRequest, FetchResponse, RenderMode, RetrievalMetadata, Timing,
    },
    safety::validate_public_url,
};
use anyhow::{anyhow, bail, Result};
use futures_util::StreamExt;
use reqwest::{header, Client, StatusCode};
use scraper::{Html, Selector};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Instant};
use url::Url;

pub async fn fetch_url(
    request: FetchRequest,
    config: Arc<Config>,
    client: Client,
    request_id: String,
) -> Result<FetchResponse> {
    fetch_url_impl(request, config, client, request_id, true).await
}

async fn fetch_url_impl(
    request: FetchRequest,
    config: Arc<Config>,
    client: Client,
    request_id: String,
    validate_urls: bool,
) -> Result<FetchResponse> {
    let started = Instant::now();
    let original_url = request.url.clone();
    let mode = request.mode.clone().unwrap_or_default();
    let render = request.render.clone().unwrap_or_default();
    let follow_redirects = request.follow_redirects.unwrap_or(true);
    let max_bytes = request
        .max_bytes
        .unwrap_or(config.max_body_bytes)
        .min(config.max_body_bytes);
    let timeout = std::time::Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(config.request_timeout_ms)
            .min(config.request_timeout_ms),
    );

    let mut current = if validate_urls {
        validate_public_url(&request.url).await?
    } else {
        Url::parse(&request.url).map_err(|error| anyhow!("invalid test URL: {error}"))?
    };
    let mut redirects = 0usize;
    let mut warnings = Vec::new();
    if request.respect_robots.unwrap_or(true) {
        warnings.push("robots policy inspection is not yet implemented; callers should use same-origin crawling conservatively".to_string());
    }
    if !matches!(render, RenderMode::Never) {
        warnings.push("browser rendering is not enabled in this base profile; returned content was fetched over HTTP".to_string());
    }

    let (status, content_type, body, final_url) = loop {
        let response = client
            .get(current.clone())
            .timeout(timeout)
            .header(header::USER_AGENT, &config.user_agent)
            .send()
            .await
            .map_err(|e| anyhow!("fetch failed: {e}"))?;

        let status = response.status();
        if follow_redirects && status.is_redirection() && redirects < config.max_redirects {
            if let Some(location) = response.headers().get(header::LOCATION) {
                let location = location
                    .to_str()
                    .map_err(|_| anyhow!("redirect location is not valid UTF-8"))?;
                let next = current
                    .join(location)
                    .map_err(|e| anyhow!("invalid redirect location: {e}"))?;
                current = if validate_urls {
                    validate_public_url(next.as_str()).await?
                } else {
                    next
                };
                redirects += 1;
                continue;
            }
        }

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        if response.content_length().unwrap_or(0) > max_bytes as u64 {
            bail!("response exceeds max_bytes limit")
        }

        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| anyhow!("response body failed: {e}"))?;
            if bytes.len().saturating_add(chunk.len()) > max_bytes {
                bail!("response exceeds max_bytes limit")
            }
            bytes.extend_from_slice(&chunk);
        }
        break (status, content_type, bytes, current.to_string());
    };

    let hash = hex_digest(&body);
    let mut document = Document {
        title: None,
        description: None,
        canonical_url: None,
        language: None,
        text: None,
        markdown: None,
        html: None,
        links: Vec::new(),
        images: Vec::new(),
        sha256: hash,
    };

    let is_html = content_type
        .as_deref()
        .map(|v| v.contains("text/html") || v.contains("application/xhtml"))
        .unwrap_or_else(|| body.starts_with(b"<!doctype html") || body.starts_with(b"<html"));

    if is_html {
        let html = String::from_utf8_lossy(&body).into_owned();
        let parsed = Html::parse_document(&html);
        let title_selector = Selector::parse("title").expect("valid selector");
        let description_selector =
            Selector::parse("meta[name=description]").expect("valid selector");
        let canonical_selector = Selector::parse("link[rel=canonical]").expect("valid selector");
        let html_selector = Selector::parse("html").expect("valid selector");
        let link_selector = Selector::parse("a[href]").expect("valid selector");
        let image_selector = Selector::parse("img[src]").expect("valid selector");

        document.title = parsed
            .select(&title_selector)
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .filter(|v| !v.is_empty());
        document.description = parsed
            .select(&description_selector)
            .next()
            .and_then(|e| e.value().attr("content"))
            .map(str::to_owned);
        document.canonical_url = parsed
            .select(&canonical_selector)
            .next()
            .and_then(|e| e.value().attr("href"))
            .map(str::to_owned);
        document.language = parsed
            .select(&html_selector)
            .next()
            .and_then(|e| e.value().attr("lang"))
            .map(str::to_owned);
        if request.include_links.unwrap_or(true) {
            document.links = parsed
                .select(&link_selector)
                .filter_map(|e| e.value().attr("href"))
                .map(str::to_owned)
                .take(500)
                .collect();
        }
        if request.include_images.unwrap_or(false) {
            document.images = parsed
                .select(&image_selector)
                .filter_map(|e| e.value().attr("src"))
                .map(str::to_owned)
                .take(200)
                .collect();
        }

        let text = extract_text(&parsed);
        let markdown = extract_markdown(&parsed);
        match mode {
            FetchMode::Raw => document.html = Some(html),
            FetchMode::Text => document.text = Some(text),
            FetchMode::Markdown => document.markdown = Some(markdown),
            FetchMode::Metadata => {}
        }
    } else if matches!(mode, FetchMode::Raw) {
        document.html = Some(String::from_utf8_lossy(&body).into_owned());
    } else if !matches!(mode, FetchMode::Metadata) {
        let text = String::from_utf8_lossy(&body).into_owned();
        document.text = Some(text.clone());
        if matches!(mode, FetchMode::Markdown) {
            document.markdown = Some(text);
        }
    }

    Ok(FetchResponse {
        request_id,
        retrieval: RetrievalMetadata {
            requested_url: original_url,
            final_url,
            status_code: status.as_u16(),
            content_type,
            content_length: body.len(),
            redirects,
        },
        document,
        warnings,
        timing: Timing {
            total_ms: started.elapsed().as_millis(),
        },
    })
}

fn extract_text(document: &Html) -> String {
    let selector = Selector::parse("body").expect("valid selector");
    let body = document.select(&selector).next();
    body.map(|element| element.text().collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn extract_markdown(document: &Html) -> String {
    let selector =
        Selector::parse("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote").expect("valid selector");
    let mut out = String::new();
    for element in document.select(&selector) {
        let text = element
            .text()
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            continue;
        }
        let tag = element.value().name();
        match tag {
            "h1" => out.push_str(&format!("# {text}\n\n")),
            "h2" => out.push_str(&format!("## {text}\n\n")),
            "h3" => out.push_str(&format!("### {text}\n\n")),
            "h4" => out.push_str(&format!("#### {text}\n\n")),
            "h5" => out.push_str(&format!("##### {text}\n\n")),
            "h6" => out.push_str(&format!("###### {text}\n\n")),
            "li" => out.push_str(&format!("- {text}\n")),
            "pre" => out.push_str(&format!("```\n{text}\n```\n\n")),
            "blockquote" => out.push_str(&format!("> {text}\n\n")),
            _ => out.push_str(&format!("{text}\n\n")),
        }
    }
    out.trim().to_string()
}

fn hex_digest(body: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body);
    format!("{:x}", hasher.finalize())
}

#[allow(dead_code)]
fn _status_is_success(status: StatusCode) -> bool {
    status.is_success()
}

#[cfg(test)]
mod tests {
    use super::{fetch_url_impl, Config};
    use crate::models::{FetchMode, FetchRequest};
    use axum::{http::header, response::Redirect, routing::get, Router};
    use reqwest::Client;
    use std::sync::Arc;
    use tokio::net::TcpListener;

    async fn fixture_app() -> String {
        let app = Router::new()
            .route(
                "/page",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                        r#"<!doctype html><html lang="en"><head><title>Fixture title</title><meta name="description" content="Fixture description"><link rel="canonical" href="https://canonical.example/page"></head><body><h1>Heading</h1><p>Hello <strong>world</strong>.</p><ul><li>One</li><li>Two</li></ul><blockquote>Quoted text</blockquote><pre>let x = 1;</pre><a href="/next">Next</a><img src="/image.png"></body></html>"#,
                    )
                }),
            )
            .route("/redirect", get(|| async { Redirect::temporary("/page") }))
            .route(
                "/large",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/plain")],
                        "0123456789012345678901234567890123456789",
                    )
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{}", address)
    }

    fn config(max_body_bytes: usize, max_redirects: usize) -> Arc<Config> {
        Arc::new(Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            api_token: None,
            searxng_url: "http://127.0.0.1:1".to_string(),
            user_agent: "Web-Kit-fetch-test/1.0".to_string(),
            max_body_bytes,
            max_redirects,
            request_timeout_ms: 1000,
        })
    }

    fn client() -> Client {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn extracts_metadata_text_markdown_links_images_and_hash() {
        let base = fixture_app().await;
        let response = fetch_url_impl(
            FetchRequest {
                url: format!("{base}/page"),
                mode: Some(FetchMode::Markdown),
                render: None,
                timeout_ms: Some(9000),
                max_bytes: Some(10_000),
                follow_redirects: Some(true),
                respect_robots: Some(true),
                include_links: Some(true),
                include_images: Some(true),
            },
            config(10_000, 2),
            client(),
            "fetch-test".to_string(),
            false,
        )
        .await
        .unwrap();

        assert_eq!(response.request_id, "fetch-test");
        assert_eq!(response.retrieval.status_code, 200);
        assert_eq!(response.retrieval.redirects, 0);
        assert_eq!(response.document.title.as_deref(), Some("Fixture title"));
        assert_eq!(
            response.document.description.as_deref(),
            Some("Fixture description")
        );
        assert_eq!(
            response.document.canonical_url.as_deref(),
            Some("https://canonical.example/page")
        );
        assert_eq!(response.document.language.as_deref(), Some("en"));
        assert!(response
            .document
            .markdown
            .as_deref()
            .unwrap()
            .contains("# Heading"));
        assert!(response
            .document
            .markdown
            .as_deref()
            .unwrap()
            .contains("- One"));
        assert!(response
            .document
            .markdown
            .as_deref()
            .unwrap()
            .contains("> Quoted text"));
        assert!(response.document.links.iter().any(|link| link == "/next"));
        assert!(response
            .document
            .images
            .iter()
            .any(|image| image == "/image.png"));
        assert_eq!(response.document.sha256.len(), 64);
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.contains("robots")));

        let text_response = fetch_url_impl(
            FetchRequest {
                url: format!("{base}/page"),
                mode: Some(FetchMode::Text),
                render: None,
                timeout_ms: None,
                max_bytes: None,
                follow_redirects: None,
                respect_robots: Some(false),
                include_links: Some(false),
                include_images: Some(false),
            },
            config(10_000, 2),
            client(),
            "text-test".to_string(),
            false,
        )
        .await
        .unwrap();
        assert!(text_response
            .document
            .text
            .as_deref()
            .unwrap()
            .contains("Hello world"));
        assert!(text_response.document.links.is_empty());
        assert!(text_response.document.images.is_empty());
        assert!(text_response.warnings.is_empty());

        let metadata_response = fetch_url_impl(
            FetchRequest {
                url: format!("{base}/page"),
                mode: Some(FetchMode::Metadata),
                render: None,
                timeout_ms: None,
                max_bytes: None,
                follow_redirects: None,
                respect_robots: None,
                include_links: None,
                include_images: None,
            },
            config(10_000, 2),
            client(),
            "metadata-test".to_string(),
            false,
        )
        .await
        .unwrap();
        assert!(metadata_response.document.text.is_none());
        assert!(metadata_response.document.markdown.is_none());
        assert!(metadata_response.document.html.is_none());
    }

    #[tokio::test]
    async fn follows_redirects_and_records_count() {
        let base = fixture_app().await;
        let response = fetch_url_impl(
            FetchRequest {
                url: format!("{base}/redirect"),
                mode: Some(FetchMode::Raw),
                render: None,
                timeout_ms: None,
                max_bytes: None,
                follow_redirects: Some(true),
                respect_robots: Some(false),
                include_links: None,
                include_images: None,
            },
            config(10_000, 2),
            client(),
            "redirect-test".to_string(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(response.retrieval.redirects, 1);
        assert!(response.document.html.unwrap().contains("Fixture title"));

        let no_follow = fetch_url_impl(
            FetchRequest {
                url: format!("{base}/redirect"),
                mode: Some(FetchMode::Metadata),
                render: None,
                timeout_ms: None,
                max_bytes: None,
                follow_redirects: Some(false),
                respect_robots: Some(false),
                include_links: None,
                include_images: None,
            },
            config(10_000, 2),
            client(),
            "no-redirect-test".to_string(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(no_follow.retrieval.status_code, 307);
        assert_eq!(no_follow.retrieval.redirects, 0);
    }

    #[tokio::test]
    async fn enforces_max_body_bytes_and_clamps_request_limits() {
        let base = fixture_app().await;
        let error = fetch_url_impl(
            FetchRequest {
                url: format!("{base}/large"),
                mode: Some(FetchMode::Raw),
                render: None,
                timeout_ms: None,
                max_bytes: Some(10_000),
                follow_redirects: None,
                respect_robots: Some(false),
                include_links: None,
                include_images: None,
            },
            config(16, 2),
            client(),
            "limit-test".to_string(),
            false,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("max_bytes"));
    }
}
