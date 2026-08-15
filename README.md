# Web-Kit

Web-Kit is a free-first web search and page-fetching service for Nexus Agents. It exposes a stable JSON API over multiple search providers and applies bounded, SSRF-aware HTTP fetching with normalized metadata, text, Markdown, links, and content hashes.

## Current milestone

The current implementation includes a Rust/Axum API, a self-hosted SearXNG adapter, provider fan-out and fallback modes, canonical URL deduplication with fused ranking, safe manual redirect handling, bounded streaming downloads, HTML metadata extraction, basic Markdown conversion, bearer-token authentication, health endpoints, Docker Compose, and unit tests.

The base profile intentionally does not require browser binaries, Redis, PostgreSQL, paid search keys, or an external extraction service. Playwright rendering, Trafilatura extraction, hosted providers, crawl manifests, and persistent usage accounting are extension points for subsequent milestones.

## Quick start with Docker

Copy the environment template and replace the API token before exposing the service beyond localhost.

```bash
cp .env.example .env
docker compose up --build
```

The API listens on `http://localhost:8080`. If `WEBKIT_API_TOKEN` is set, include it as a bearer token.

```bash
curl http://localhost:8080/healthz
curl -H "Authorization: Bearer replace-with-a-long-random-token" \
  "http://localhost:8080/v1/search?q=rust+async+http&providers=searxng&limit=5"
```

For local Rust development without Docker:

```bash
cargo run
cargo test
```

## API examples

### List providers

```bash
curl -H "Authorization: Bearer $WEBKIT_API_TOKEN" \
  http://localhost:8080/v1/providers
```

### Search with JSON POST

```bash
curl -X POST http://localhost:8080/v1/search \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $WEBKIT_API_TOKEN" \
  -d '{
    "query": "Rust async HTTP client documentation",
    "providers": ["searxng"],
    "mode": "fanout",
    "limit": 10,
    "language": "en",
    "safe_search": "1",
    "domains": ["docs.rs", "rust-lang.org"]
  }'
```

Search results contain a stable `id`, normalized URL, provider provenance, provider rank, fused score, and provider status metadata. Unknown providers are reported as degraded results rather than causing the whole request to fail.

### Fetch a page as Markdown

```bash
curl -X POST http://localhost:8080/v1/fetch \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $WEBKIT_API_TOKEN" \
  -d '{
    "url": "https://docs.rs/reqwest/latest/reqwest/",
    "mode": "markdown",
    "render": "never",
    "max_bytes": 5000000,
    "follow_redirects": true,
    "respect_robots": true,
    "include_links": true,
    "include_images": false
  }'
```

Web-Kit validates the original URL and every redirect target. It allows only HTTP and HTTPS URLs, rejects credentials in URLs, blocks loopback/private/link-local/multicast/reserved destinations after DNS resolution, limits redirects, enforces response-size limits, and does not follow redirects automatically inside the HTTP client.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `WEBKIT_BIND_ADDR` | `0.0.0.0:8080` | API listen address. |
| `WEBKIT_API_TOKEN` | empty | Optional bearer token. Set it in production. |
| `WEBKIT_SEARXNG_URL` | `http://searxng:8080` | SearXNG base URL. |
| `WEBKIT_USER_AGENT` | Web-Kit identifier | User agent sent to upstream services. |
| `WEBKIT_MAX_BODY_BYTES` | `5242880` | Maximum fetched body size. |
| `WEBKIT_MAX_REDIRECTS` | `5` | Maximum validated redirects. |
| `WEBKIT_REQUEST_TIMEOUT_MS` | `12000` | Maximum upstream request timeout. |
| `RUST_LOG` | `web_kit=info,tower_http=info` | Structured logging filter. |
| `SEARXNG_IMAGE` | `searxng/searxng:latest` | SearXNG image; pin a reviewed tag in production. |

SearXNG JSON output is enabled in `docker/searxng/settings.yml`. The supplied configuration is a starting point; review enabled engines, their terms, rate limits, and availability before production use.

## Repository layout

```text
src/main.rs       Axum routes, auth, health checks, and request validation
src/models.rs     Stable API request and response types
src/providers.rs  Provider abstraction, SearXNG adapter, deduplication, and ranking
src/fetcher.rs    Safe HTTP fetch, redirect handling, HTML parsing, Markdown output
src/safety.rs     DNS-aware SSRF protections
src/config.rs     Environment-driven configuration
Dockerfile        Multi-stage non-root production image
docker-compose.yml  API plus internal SearXNG topology
docker/searxng/   SearXNG settings
```

## Provider roadmap

The first release keeps SearXNG as the only configured Web-Kit adapter because it can aggregate multiple engines behind one controlled interface. The provider trait is ready for Mojeek, Brave, Tavily, and other adapters. Hosted providers should be enabled only with explicit keys, per-provider budgets, and quota-aware policies. Direct DuckDuckGo HTML access is intentionally not enabled by default because it is not a stable official full-search API contract.

## Production notes

The service should be placed behind TLS and an upstream reverse proxy. Set a long random `WEBKIT_API_TOKEN`, pin the SearXNG image, review the SearXNG engine configuration, restrict the exposed network, and monitor provider errors and latency. The browser-rendering profile is not part of this base image; adding Playwright should use a separate low-privilege container with resource and network restrictions.

## License

MIT
