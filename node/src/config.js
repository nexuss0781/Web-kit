/**
 * Configuration, read once from the environment.
 *
 * The defaults are for a hosted service: several free providers, no SearXNG,
 * because a public instance is the least reliable thing this service could
 * depend on. Point WEBKIT_SEARXNG_URLS at instances you control and that
 * provider joins the set.
 */

function list(value, fallback) {
  if (!value) return fallback;
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  return {
    // Wasmer injects PORT and expects a numeric port passed separately from the
    // host; listen('0.0.0.0:8080') is refused there.
    host: env.WEBKIT_HOST || env.HOST || '0.0.0.0',
    port: integer(env.WEBKIT_PORT || env.PORT, 3000),
    bindAddr: `${env.WEBKIT_HOST || env.HOST || '0.0.0.0'}:${integer(env.WEBKIT_PORT || env.PORT, 3000)}`,
    apiToken: env.WEBKIT_API_TOKEN || null,
    userAgent: env.WEBKIT_USER_AGENT || 'Web-Kit/0.1 (+https://github.com/nexuss0781/Web-kit)',

    /** Empty means every provider that is available in this deployment. */
    providers: list(env.WEBKIT_PROVIDERS, []),
    searxngUrls: list(env.WEBKIT_SEARXNG_URLS || env.WEBKIT_SEARXNG_URL, []),
    githubToken: env.WEBKIT_GITHUB_TOKEN || null,

    maxBodyBytes: integer(env.WEBKIT_MAX_BODY_BYTES, 5_242_880),
    maxRedirects: integer(env.WEBKIT_MAX_REDIRECTS, 5),
    timeoutMs: integer(env.WEBKIT_REQUEST_TIMEOUT_MS, 12_000),
    searchTimeoutMs: integer(env.WEBKIT_SEARCH_TIMEOUT_MS, 10_000),
  };
}
