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

pub async fn fetch_url(
    request: FetchRequest,
    config: Arc<Config>,
    client: Client,
    request_id: String,
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

    let mut current = validate_public_url(&request.url).await?;
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
                current = validate_public_url(next.as_str()).await?;
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
