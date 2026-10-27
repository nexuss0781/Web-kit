/**
 * Configuration, read once from the environment.
 *
 * The defaults are for a hosted service: several free providers, no SearXNG,
 * because a public instance is the least reliable thing this service could
 * depend on. Point WEBKIT_SEARXNG_URLS at instances you control and that
 * provider joins the set; set FIRECRAWL_API_KEY and the general web index joins
 * it too, along with JavaScript rendering for /v1/fetch.
 */

function list(value, fallback) {
  if (!value) return fallback;
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(value);
}

export function loadConfig(env = process.env) {
  return {
    // Wasmer injects PORT and expects a numeric port passed separately from the
    // host; listen('0.0.0.0:8080') is refused there.
    host: env.WEBKIT_HOST || env.HOST || '0.0.0.0',
    port: integer(env.WEBKIT_PORT || env.PORT, 3000),
    bindAddr: `${env.WEBKIT_HOST || env.HOST || '0.0.0.0'}:${integer(env.WEBKIT_PORT || env.PORT, 3000)}`,
    apiToken: env.WEBKIT_API_TOKEN || null,
    /**
     * Who this process is.
     *
     * Two servers can listen on the same port on Windows, because its
     * SO_REUSEADDR lets a specific address sit next to a wildcard one. The
     * health endpoints echo this value, so the SDK can tell its own daemon from
     * the stranger that may be sharing the port instead of trusting whoever
     * answers first. Unset in a plain deployment, where nothing compares it.
     */
    instance: env.WEBKIT_INSTANCE || null,
    userAgent: env.WEBKIT_USER_AGENT || 'Web-Kit/0.1 (+https://github.com/nexuss0781/Web-kit)',

    /**
     * Where asynchronous state lives: crawl, batch and extract jobs, and the
     * monitor list. `WEBKIT_HOME` is the SDK's directory, so a daemon and a
     * `webkit` one-shot command see the same jobs without being configured
     * twice. Null means `~/.webkit`, resolved by the job store.
     */
    dataDir: env.WEBKIT_HOME || env.WEBKIT_DATA_DIR || null,
    /**
     * The address a job's status URL should name. A local engine is reached at
     * loopback, but a deployment behind a proxy would otherwise hand out a
     * `127.0.0.1` URL nobody else can open.
     */
    publicUrl: (env.WEBKIT_PUBLIC_URL || '').replace(/\/+$/, '') || null,

    /** Empty means every provider that is available in this deployment. */
    providers: list(env.WEBKIT_PROVIDERS, []),
    searxngUrls: list(env.WEBKIT_SEARXNG_URLS || env.WEBKIT_SEARXNG_URL, []),
    /**
     * The order the compatibility surface tries providers in.
     *
     * The SDK's default puts SearXNG first because it is local, free and
     * richest; keyless Firecrawl is the general index behind it, the verticals
     * are the backstop, and a keyed call is last because it spends money. A
     * deployment that has no SearXNG simply starts further down the list.
     */
    searchTiers: list(env.WEBKIT_SEARCH_TIERS, []),
    /** Fewer results than this from a tier is a reason to try the next one. */
    searchMinResults: integer(env.WEBKIT_SEARCH_MIN_RESULTS, 3),
    githubToken: env.WEBKIT_GITHUB_TOKEN || null,

    // The one provider that needs a key, and the only general web index here.
    // It joins the default set as soon as FIRECRAWL_API_KEY is present and is
    // what `render: auto|always` uses for JavaScript pages.
    firecrawlApiKey: env.FIRECRAWL_API_KEY || null,
    /**
     * Where *outbound* Firecrawl calls go. A self-hosted Firecrawl changes only
     * the host; the paths are the same.
     *
     * `WEBKIT_FIRECRAWL_UPSTREAM` exists because `FIRECRAWL_API_URL` means the
     * opposite thing to the Firecrawl CLI: the CLI sends requests *to* that
     * address, while this service forwards requests *to* it. The SDK sets
     * `FIRECRAWL_API_URL` to itself so the CLI and the skills work, and must not
     * let that same variable turn this service into its own upstream. It sets
     * the explicit name instead.
     */
    firecrawlApiUrl: (env.WEBKIT_FIRECRAWL_UPSTREAM || env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev').replace(/\/+$/, ''),
    /**
     * Whether the free, unauthenticated Firecrawl tier may be used.
     *
     * It answers from a cloud address and refuses addresses it reads as VPN or
     * proxy, which is why it is a switch rather than an assumption: a
     * deployment on a flagged network would pay a failed round trip on every
     * search for an answer it can never get. Off, the compat surface falls
     * straight through to the local providers.
     */
    keylessFirecrawl: bool(env.WEBKIT_KEYLESS_FIRECRAWL, true),
    // How old a reused copy of a page may be, in ms. 0 forces a fresh read,
    // which costs more and is only right for something time sensitive.
    firecrawlMaxAge: integer(env.FIRECRAWL_MAX_AGE_MS, 172_800_000),
    /**
     * Whether Firecrawl may fetch a caller-named URL in its own cloud.
     *
     * Everything else in this service resolves a name once, checks the address
     * and dials exactly that address. Rendering cannot: the request is made by
     * Firecrawl, from their network, resolving the name themselves. So the check
     * above proves the name was public when we asked, not when they ask, and a
     * name that answers differently the second time is not covered by it.
     *
     * This does not put *this* deployment at risk -- nothing here dials the
     * rebound address, so our own private space stays private. What it exposes
     * is Firecrawl's network, which they filter themselves.
     *
     * Set WEBKIT_ALLOW_REMOTE_RENDER=0 to refuse remote rendering of
     * caller-named URLs outright. `render: auto` then simply reports unrendered
     * rather than escalating, and nothing breaks.
     */
    allowRemoteRender: bool(env.WEBKIT_ALLOW_REMOTE_RENDER, true),

    maxBodyBytes: integer(env.WEBKIT_MAX_BODY_BYTES, 5_242_880),
    maxRedirects: integer(env.WEBKIT_MAX_REDIRECTS, 5),
    timeoutMs: integer(env.WEBKIT_REQUEST_TIMEOUT_MS, 12_000),
    searchTimeoutMs: integer(env.WEBKIT_SEARCH_TIMEOUT_MS, 10_000),

    /**
     * An optional local model, used for the formats that need judgement rather
     * than parsing: `json`, `summary`, and a prompted `extract`.
     *
     * This project deliberately runs no browser, so these cannot be answered by
     * rendering. They can be answered by a model, and the cheapest place to get
     * one is the machine the service is already on. Ollama is the default
     * probe; an OpenAI-compatible endpoint is the alternative for a deployment
     * that already has one. Neither is required: without them the deterministic
     * formats still work and the model-backed ones say exactly what is missing.
     */
    ollamaUrl: (env.WEBKIT_OLLAMA_URL || env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    llmProvider: (env.WEBKIT_LLM_PROVIDER || '').toLowerCase() || null,
    llmModel: env.WEBKIT_LLM_MODEL || null,
    llmTimeoutMs: integer(env.WEBKIT_LLM_TIMEOUT_MS, 90_000),
    openaiApiKey: env.OPENAI_API_KEY || null,
    openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    openaiModel: env.WEBKIT_LLM_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}
