/**
 * Firecrawl's v2 surface, answered by this service.
 *
 * The Firecrawl skills are procedures, not code: they shell out to
 * `firecrawl <command>` and the CLI takes `--api-url` (or FIRECRAWL_API_URL).
 * So the cheapest way to keep all of them working is to answer the handful of
 * endpoints they call, in the shape they expect, rather than rewriting
 * twenty-three procedures that will drift the next time the catalogue updates.
 *
 * What sits behind those endpoints is a ladder, not a provider:
 *
 *   1. SearXNG        local, free, richest, and the one an SDK can run itself
 *   2. keyless Firecrawl   a real general index, no credential
 *   3. the verticals  Wikipedia, arXiv, GitHub, Hacker News, Crossref, books
 *   4. keyed Firecrawl     last, because it spends money
 *
 * A tier that answers with fewer than a handful of results is a reason to try
 * the next one, not an answer. That is what "only when needed" means here: a
 * normal software question never leaves the first two tiers, and a keyed call
 * only happens when the free ones genuinely could not answer.
 *
 * Formats this service cannot produce -- a schema-validated `json`, a
 * `screenshot`, a `branding` block -- are refused rather than answered with an
 * empty success. An agent that asked for structured data and got `{}` would
 * carry on as though the page had been empty.
 */

import crypto from 'node:crypto';
import { fetchDocument } from './fetcher.js';
import { htmlToMarkdown } from './markdown.js';
import { search as localSearch, enabledProviders } from './search.js';
import { chatJson, chatText, describeModel } from './llm.js';
import { structuredFromHtml } from './extract.js';
import { extractAttributes } from './selectors.js';
import * as firecrawl from './firecrawl.js';
import searxngProvider, { categoriesFor } from './providers/searxng.js';

/**
 * Formats that are a document this service can actually produce.
 *
 * `json`, `summary` and `question` are produced when a model exists -- a local
 * Ollama, an OpenAI-compatible endpoint, or a keyed Firecrawl as the last tier.
 * `attributes` needs no model: it reads data attributes out of the markup.
 */
export const PRODUCIBLE = new Set([
  'markdown', 'html', 'rawHtml', 'links', 'images',
  'json', 'summary', 'question', 'attributes', 'extract', 'deterministicJson',
]);

/** The order when a deployment has not named one. */
const DEFAULT_TIERS = ['searxng', 'firecrawl-keyless', 'verticals', 'firecrawl-key'];

/** How long a refused keyless tier is left alone before it is tried again. */
const KEYLESS_COOLDOWN_MS = 60_000;

/**
 * When each upstream last refused us, in epoch ms, keyed by base URL.
 *
 * Firecrawl's keyless tier works from some networks and refuses others
 * outright. Without this, every search on a refused network would wait out the
 * whole upstream timeout to learn the same thing, so the answer is remembered
 * for a minute. Keyed by URL so a self-hosted instance being down does not
 * disable the hosted one. A keyed call never consults it.
 */
const keylessDownUntil = new Map();

function keylessKey(config) {
  return config.firecrawlApiUrl ?? 'default';
}

function keylessUsable(config) {
  return config.keylessFirecrawl !== false
    && Date.now() >= (keylessDownUntil.get(keylessKey(config)) ?? 0);
}

function failedKeyless(config) {
  keylessDownUntil.set(keylessKey(config), Date.now() + KEYLESS_COOLDOWN_MS);
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function clamp(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** A host without its scheme, `www.`, or path -- the only part `site:` wants. */
function hostOf(value) {
  return String(value ?? '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '');
}

/**
 * Firecrawl lets a caller name domains instead of writing `site:` clauses.
 * These are folded into the query rather than passed as a parameter, because
 * that is the one form every tier understands.
 */
function withDomainFilters(query, include, exclude) {
  let combined = firecrawl.withDomains(query, include);
  for (const domain of [].concat(exclude ?? []).map(hostOf).filter(Boolean)) {
    combined += ` -site:${domain}`;
  }
  return combined.trim();
}

/** `sources` arrives as strings or as `{type}` objects, and both mean the same. */
function sourceTypes(body) {
  const raw = body.sources ?? body.source ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  const named = list
    .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
    .filter(Boolean)
    .map((entry) => String(entry).toLowerCase());
  const known = named.filter((entry) => ['web', 'news', 'images'].includes(entry));
  return known.length ? [...new Set(known)] : ['web'];
}

/** Our recency vocabulary, for the local tiers, from Firecrawl's Google codes. */
const TIME_RANGE = new Map([
  ['qdr:h', 'day'], ['qdr:d', 'day'], ['qdr:w', 'week'], ['qdr:m', 'month'], ['qdr:y', 'year'],
]);

function recency(body) {
  const named = text(body.tbs ?? body.time_range ?? body.timeRange).toLowerCase();
  return TIME_RANGE.get(named) ?? (['day', 'week', 'month', 'year'].includes(named) ? named : undefined);
}

/**
 * The requested formats, with their options.
 *
 * Firecrawl accepts `formats: ['markdown']` and `formats: [{ type: 'json',
 * schema, prompt }]` in the same array. Both forms mean the same thing; only
 * the second carries everything. A Map keeps one entry per type, and a later
 * object wins over an earlier string, so a caller that says a format twice gets
 * the version that says more.
 */
export function formatSpecs(body) {
  const raw = body?.formats ?? ['markdown'];
  const list = Array.isArray(raw) ? raw : [raw];
  const specs = new Map();
  for (const entry of list) {
    if (typeof entry === 'string' && entry) {
      specs.set(entry, { type: entry });
    } else if (entry && typeof entry === 'object' && typeof entry.type === 'string') {
      specs.set(entry.type, entry);
    }
  }
  if (specs.size === 0) specs.set('markdown', { type: 'markdown' });
  return specs;
}

export function formatsOf(body) {
  return new Set(formatSpecs(body).keys());
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: 'E_BAD_REQUEST' });
}

/** Rows from any tier, in the shape Firecrawl's `data.*` uses. */
function asItem(row, position) {
  const item = {
    url: row.url,
    title: row.title,
    description: row.snippet ?? row.description ?? '',
    position,
  };
  if (row.published_at) item.date = row.published_at;
  if (row.category === 'images' && row.thumbnail) item.imageUrl = row.thumbnail;
  return item;
}

/**
 * Which SearXNG categories answer this request.
 *
 * A news question is not a general question with different ranking; the
 * `news` category is a different engine set. So the requested groups become
 * categories, and a plain web search stays on `general`.
 */
function searxngCategories(named, sources) {
  const wanted = categoriesFor(named);
  for (const source of sources) {
    if (source === 'news' && !wanted.includes('news')) wanted.push('news');
    if (source === 'images' && !wanted.includes('images')) wanted.push('images');
  }
  if (sources.includes('web') && !wanted.some((name) => ['general', 'news', 'science', 'it', 'files'].includes(name))) {
    wanted.push('general');
  }
  return wanted.length ? wanted : ['general'];
}

/** Group order matters: the first requested group is the one the caller reads. */
function emptyGroups(sources) {
  return Object.fromEntries(sources.map((source) => [source, []]));
}

function groupCount(groups) {
  return Object.values(groups).reduce((total, rows) => total + rows.length, 0);
}

/** Adds rows that are not already present, so two tiers answering do not duplicate. */
function mergeInto(groups, incoming) {
  const seen = new Set(Object.values(groups).flat().map((item) => item.url));
  let added = 0;
  for (const [name, rows] of Object.entries(incoming)) {
    if (!groups[name]) groups[name] = [];
    for (const row of rows) {
      if (!row.url || seen.has(row.url)) continue;
      seen.add(row.url);
      row.position = groups[name].length + 1;
      groups[name].push(row);
      added += 1;
    }
  }
  return added;
}

/** Tier 1: the local metasearch instance. */
async function searxngTier(context) {
  const { config, query, limit, timeRange, sources, body } = context;
  if (!config.searxngUrls?.length) return null;

  const result = await searxngProvider.search({
    query,
    limit: Math.max(limit, 10),
    categories: searxngCategories(body.categories, sources),
    time_range: timeRange,
    language: text(body.language ?? body.lang) || undefined,
    pageno: clamp(body.page ?? body.pageno, 1, 10, 1),
    safe_search: body.safeSearch ?? body.safe_search,
  }, config);

  const groups = emptyGroups(sources);
  const split = sources.length > 1;
  for (const row of result.rows) {
    const bucket = !split
      ? sources[0]
      : (row.category === 'news' ? 'news' : row.category === 'images' ? 'images' : 'web');
    // A group that was not asked for is dropped rather than invented.
    if (!groups[bucket]) continue;
    // SearXNG is asked for at least ten rows because de-duplication across
    // instances costs some; the caller's limit is what is returned.
    if (groups[bucket].length >= limit) continue;
    groups[bucket].push(asItem(row, groups[bucket].length + 1));
  }

  return {
    groups,
    extras: {
      ...(result.answers.length ? { answers: result.answers } : {}),
      ...(result.infoboxes.length ? { infoboxes: result.infoboxes } : {}),
      ...(result.suggestions.length ? { suggestions: result.suggestions } : {}),
      ...(result.unresponsive.length ? { unresponsive_engines: result.unresponsive } : {}),
    },
    warnings: result.warnings,
  };
}

/**
 * Tier 2 and 4: Firecrawl's index, without and with a credential.
 *
 * One function because the request is identical; only the header differs. What
 * separates them is policy, not protocol: keyless is a main provider, keyed is
 * the fallback that only runs when the free tiers came up short.
 */
async function firecrawlTier(context, { keyless }) {
  const { config, query, limit, sources, body } = context;
  if (keyless && !keylessUsable(config)) return null;
  if (!keyless && !config.firecrawlApiKey) return null;

  const options = {
    apiKey: keyless ? null : config.firecrawlApiKey,
    timeoutMs: config.searchTimeoutMs,
    baseUrl: config.firecrawlApiUrl,
  };
  // Every requested group is named, web included: `sources` replaces the
  // default rather than adding to it, so omitting web would drop the general
  // results from a search that also asked for news. A plain web search sends
  // nothing, because that is already the default.
  const named = !(sources.length === 1 && sources[0] === 'web');
  const full = {
    query,
    limit,
    ...(named ? { sources: sources.map((type) => ({ type })) } : {}),
    ...(text(body.tbs) ? { tbs: text(body.tbs) } : {}),
    ...(Array.isArray(body.categories) && body.categories.length ? { categories: body.categories } : {}),
  };

  let answer;
  try {
    answer = await firecrawl.v2Search(full, options);
  } catch (error) {
    // A filter the index rejects must not cost us the index itself.
    try {
      answer = await firecrawl.v2Search({ query, limit }, options);
    } catch (retryError) {
      if (keyless) failedKeyless(config);
      throw retryError;
    }
  }

  const upstream = answer?.data ?? {};
  const groups = emptyGroups(sources);
  for (const source of sources) {
    const rows = Array.isArray(upstream[source]) ? upstream[source] : [];
    groups[source] = rows.map((row, index) => ({
      url: row.url,
      title: row.title,
      description: row.description ?? '',
      position: row.position ?? index + 1,
      ...(row.date ? { date: row.date } : {}),
      ...(row.imageUrl ? { imageUrl: row.imageUrl } : {}),
      ...(row.markdown ? { markdown: row.markdown } : {}),
    }));
  }
  return { groups, extras: {} };
}

/** Tier 3: the vertical indexes, which need no instance and no credential. */
async function verticalTier(context) {
  const { config, query, limit, timeRange } = context;
  const providers = enabledProviders(config)
    .map((provider) => provider.id)
    .filter((id) => id !== 'firecrawl' && id !== 'searxng');
  if (!providers.length) return null;

  const result = await localSearch({
    query,
    limit,
    mode: 'fanout',
    ...(timeRange ? { time_range: timeRange } : {}),
    providers,
  }, config);

  const groups = emptyGroups(context.sources);
  const target = groups.web ?? groups[context.sources[0]];
  for (const [index, row] of (result.results ?? []).entries()) {
    target.push(asItem({ ...row, published_at: null }, index + 1));
  }
  return { groups, extras: {} };
}

async function runTier(name, context) {
  switch (name) {
    case 'searxng': return searxngTier(context);
    case 'firecrawl-keyless': return firecrawlTier(context, { keyless: true });
    case 'firecrawl-key': return firecrawlTier(context, { keyless: false });
    case 'verticals': return verticalTier(context);
    default: return null;
  }
}

/**
 * POST|GET /v2/search.
 *
 * Answers with grouped results, because that is what the caller indexed into:
 * `data.web`, `data.news`, `data.images`. Groups we were not asked for are left
 * out rather than sent empty, so a caller checking `data.news` knows the
 * difference between "nothing found" and "not requested".
 */
export async function v2Search(body = {}, config = {}) {
  const query = text(body.query);
  if (!query) throw badRequest('query is required');
  if (query.length > 1000) throw badRequest('query over 1000 characters');

  const limit = clamp(body.limit, 1, 100, 10);
  const sources = sourceTypes(body);
  const combined = withDomainFilters(
    query,
    [].concat(body.includeDomains ?? body.include_domains ?? []),
    [].concat(body.excludeDomains ?? body.exclude_domains ?? []),
  );

  const context = { config, body, query: combined, limit, sources, timeRange: recency(body) };
  const tiers = config.searchTiers?.length ? config.searchTiers : DEFAULT_TIERS;
  // Enough is enough: a tier that returns this many results is the answer.
  const need = Math.min(config.searchMinResults ?? 3, limit);
  const groups = emptyGroups(sources);
  const tried = [];
  const notes = [];
  let extras = {};

  for (const name of tiers) {
    let outcome;
    try {
      outcome = await runTier(name, context);
    } catch (error) {
      // A tier that was asked and failed is part of the story; a tier that is
      // not configured is not.
      tried.push(name);
      notes.push(`${name}: ${error.message}`);
      continue;
    }
    if (!outcome) continue;
    tried.push(name);
    mergeInto(groups, outcome.groups);
    extras = { ...extras, ...outcome.extras };
    if (groupCount(groups) >= need) break;
  }

  // A tier may answer with more than was asked for -- an upstream minimum, or
  // two tiers merging -- and the caller's limit is the one that decides. Applied
  // per group, because "five results" for a news search means five news items.
  for (const [name, rows] of Object.entries(groups)) {
    if (rows.length <= limit) continue;
    groups[name] = rows.slice(0, limit);
    groups[name].forEach((row, index) => { row.position = index + 1; });
  }

  const data = { ...groups };
  // The extras belong to the search, not to a provider, so they sit beside the
  // groups. A caller that does not know the field ignores it; a caller reading
  // a direct answer gets it instead of guessing from ten snippets.
  Object.assign(data, extras);

  // `--scrape` asks for the page content inline. Capped, because the point is
  // to save a round trip on the two or three results worth reading, not to
  // fetch everything the index returned.
  const wanted = formatsOf(body.scrapeOptions ?? {});
  if (body.scrapeOptions && wanted.has('markdown')) {
    const group = data.web ?? [];
    const take = Math.min(group.length, 3);
    const pages = await Promise.allSettled(group.slice(0, take).map((item) => fetchDocument(item.url, {
      mode: 'markdown',
      timeout_ms: config.timeoutMs,
      max_bytes: config.maxBodyBytes,
    }, config)));
    for (const [index, outcome] of pages.entries()) {
      if (outcome.status === 'fulfilled' && outcome.value.document.markdown) {
        group[index].markdown = outcome.value.document.markdown;
      }
    }
  }

  return {
    success: true,
    data,
    id: `search_${crypto.randomUUID()}`,
    // Which tier actually answered. Firecrawl clients ignore it; `webkit doctor`
    // and anyone debugging a thin result set do not.
    ...(tried.length ? { tiers_tried: tried } : {}),
    ...(notes.length ? { warnings: notes } : {}),
  };
}

/**
 * POST /v2/scrape.
 *
 * One URL in, the requested representations out. The formats are produced from
 * a single read: asking for markdown and links is one fetch and two views of
 * it, not two fetches.
 *
 * Model-shaped formats follow the same tiers as `extract`: a local model if one
 * is running, the deterministic reader when the request can be answered from
 * structured markup, a keyed Firecrawl when a key exists, and an honest refusal
 * when a prompt needs a model and there is none.
 */
export async function v2Scrape(body = {}, config = {}) {
  const target = text(body.url);
  if (!target) throw badRequest('url is required');

  const specs = formatSpecs(body);
  const formats = new Set(specs.keys());
  const unsupported = [...formats].filter((format) => !PRODUCIBLE.has(format));
  if (unsupported.length) {
    throw badRequest(`format ${unsupported.map((f) => `'${f}'`).join(', ')} is not produced by this deployment; available formats are ${[...PRODUCIBLE].join(', ')}`);
  }

  const wantsHtml = formats.has('html') || formats.has('rawHtml');
  // Attributes are read from markup, so they need the raw document too.
  const wantsMarkup = wantsHtml || formats.has('attributes');
  const result = await fetchDocument(target, {
    // Raw HTML is what both `html` and `rawHtml` are made from; markdown is
    // derived from it in that case, so one read serves every requested view.
    mode: wantsMarkup ? 'raw' : 'markdown',
    timeout_ms: clamp(body.timeout ?? body.timeout_ms, 100, config.timeoutMs, config.timeoutMs),
    max_bytes: config.maxBodyBytes,
    include_links: formats.has('links'),
    include_images: formats.has('images'),
    follow_redirects: true,
    respect_robots: true,
  }, config);

  const raw = result.document.raw ?? null;
  const markdown = result.document.markdown ?? (raw ? htmlToMarkdown(raw) : '');
  const metadata = result.document.metadata ?? {};

  const data = {
    metadata: {
      title: metadata.title ?? null,
      description: metadata.description ?? null,
      language: metadata.language ?? null,
      sourceURL: result.retrieval.final_url,
      url: result.retrieval.final_url,
      statusCode: result.retrieval.status,
      contentType: result.retrieval.content_type,
      // Everything here was read just now, in this request. Saying so is the
      // difference between "fresh" and "we do not know", which a caller
      // deciding whether to trust a price depends on.
      cacheState: 'miss',
      cachedAt: new Date().toISOString(),
      ...(metadata.published_at ? { publishedTime: metadata.published_at } : {}),
      ...(result.retrieval.truncated ? { truncated: true } : {}),
      ...(result.warnings?.length ? { warning: result.warnings.join('; ') } : {}),
    },
  };

  if (formats.has('markdown')) data.markdown = markdown;
  if (formats.has('html')) data.html = raw ?? markdown;
  if (formats.has('rawHtml')) data.rawHtml = raw ?? markdown;
  if (formats.has('links')) data.links = metadata.links ?? [];
  if (formats.has('images')) data.images = result.document.images ?? [];

  if (formats.has('attributes')) {
    const spec = specs.get('attributes');
    data.attributes = extractAttributes(raw ?? '', [].concat(spec.selectors ?? []));
  }

  // The deterministic reader answers a schema with no model, and answers it
  // from what the page states about itself, which is often better than a guess.
  const pageFacts = {
    title: metadata.title ?? null,
    description: metadata.description ?? null,
    url: result.retrieval.final_url,
  };

  if (formats.has('deterministicJson')) {
    data.json = structuredFromHtml(raw ?? '', specs.get('deterministicJson').schema, pageFacts);
  }

  const modelFormats = ['json', 'extract'].filter((format) => formats.has(format));
  const needsText = modelFormats.length > 0 || formats.has('summary') || formats.has('question');
  if (needsText) {
    const model = await describeModel(config);
    const wantsPrompt = [...modelFormats, 'summary', 'question'].some((format) => {
      const spec = specs.get(format);
      if (!spec) return false;
      if (format === 'summary') return false;
      return Boolean(text(spec.prompt ?? spec.question)) && !spec.schema;
    });

    if (!model) {
      if (config.firecrawlApiKey) {
        // A model exists upstream and the caller supplied a key; the request is
        // theirs, so it is forwarded rather than partially answered.
        return firecrawl.scrapeV2(body, config);
      }
      for (const format of modelFormats) {
        const spec = specs.get(format);
        if (!spec.schema || text(spec.prompt)) {
          throw Object.assign(new Error(`format '${format}' needs a model: start Ollama, set OPENAI_API_KEY, or provide a Firecrawl key; 'json' with only a schema is answered from structured markup, 'attributes' needs no model`), {
            status: 501,
            code: 'E_NO_LLM',
          });
        }
        const shaped = structuredFromHtml(raw ?? '', spec.schema, pageFacts);
        if (format === 'extract') data.extract = shaped;
        else data.json = shaped;
      }
    } else {
      const pageText = (markdown || raw || '').slice(0, 40_000);
      let tokensUsed = 0;

      if (formats.has('json') || formats.has('extract')) {
        const format = formats.has('json') ? 'json' : 'extract';
        const spec = specs.get(format);
        const answer = await chatJson({
          system: 'You extract facts from a web page. Use only the text provided. Never invent a value: omit a field the page does not state.',
          prompt: `${text(spec.prompt) || 'Extract the data described by the schema from this page.'}\n\n${pageText}`,
          schema: spec.schema ?? undefined,
          config,
        });
        if (format === 'extract') data.extract = answer.json;
        else data.json = answer.json;
        tokensUsed += answer.tokensUsed ?? 0;
      }

      if (formats.has('summary')) {
        const answer = await chatText({
          system: 'You summarise web pages. Use only the text provided, and keep the summary under 150 words.',
          prompt: pageText || metadata.description || metadata.title || '',
          config,
        });
        data.summary = answer.text;
        tokensUsed += answer.tokensUsed ?? 0;
      }

      if (formats.has('question')) {
        const question = text(specs.get('question').question ?? specs.get('question').prompt);
        if (question) {
          const answer = await chatText({
            system: 'You answer questions from a web page. Answer from the text provided; if it does not contain the answer, say so.',
            prompt: `${question}\n\n${pageText}`,
            config,
          });
          data.answer = answer.text;
          tokensUsed += answer.tokensUsed ?? 0;
        }
      }

      data.metadata.model = `${model.provider}:${model.model}`;
      data.metadata.tokensUsed = tokensUsed || undefined;
    }

    // `wantsPrompt` is documentation of what the gate above is about: a schema
    // can be answered without a model, a free-form prompt cannot.
    void wantsPrompt;
  }

  return { success: true, data };
}

/**
 * GET|POST /v2/search/developer.
 *
 * Passed through when a Firecrawl tier allows it, keyless first. The fallback
 * is GitHub repository search, which is a much weaker thing -- repositories,
 * not the issue or the merged PR that answers the question -- but it is the
 * right shape and it is better than an empty list when the index is refused.
 */
export async function v2DeveloperSearch(input = {}, config = {}) {
  const query = text(input.query ?? input.q);
  if (!query) throw badRequest('query is required');

  const k = clamp(input.k ?? input.limit, 1, 25, 5);
  const params = new URLSearchParams({ query, k: String(k) });
  for (const key of ['types', 'repos', 'sources']) {
    const value = input[key];
    if (value && (!Array.isArray(value) || value.length)) {
      params.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
  }

  const tiers = [];
  if (keylessUsable(config)) tiers.push({ apiKey: null, keyless: true });
  if (config.firecrawlApiKey) tiers.push({ apiKey: config.firecrawlApiKey, keyless: false });

  let lastError = null;
  for (const tier of tiers) {
    try {
      return await firecrawl.v2DeveloperSearch(params.toString(), {
        apiKey: tier.apiKey,
        timeoutMs: config.searchTimeoutMs,
        baseUrl: config.firecrawlApiUrl,
      });
    } catch (error) {
      lastError = error;
      if (tier.keyless) failedKeyless(config);
    }
  }

  if (!config.githubToken) {
    throw lastError ?? badRequest('no developer index is available on this deployment');
  }

  const result = await localSearch({ query, limit: k, mode: 'fanout', providers: ['github'] }, config);
  const results = (result.results ?? []).map((row) => ({
    id: `web:${row.url}`,
    url: row.url,
    title: row.title,
    passages: row.snippet ? [{ text: row.snippet }] : [],
  }));
  return { success: true, partial: true, results };
}
