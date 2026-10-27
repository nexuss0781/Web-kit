/**
 * POST /v2/extract            GET /v2/extract/:id
 *
 * "Give me these fields from these pages." Firecrawl answers with a hosted
 * model. This service answers in three tiers, best available first:
 *
 *   1. A local model (Ollama or an OpenAI-compatible endpoint) when one exists.
 *      Full freedom: a prompt, a JSON Schema, or both.
 *   2. A deterministic reader when there is no model: JSON-LD, microdata,
 *      OpenGraph, meta tags and tables, filtered through the caller's schema.
 *      Every value comes from the page, which for a lot of pages is better than
 *      a model -- prices, dates and names are stated in structured markup
 *      precisely because machines are meant to read them.
 *   3. A keyed Firecrawl, when the caller supplied one, for a prompt that only
 *      a model can answer and no local model is available.
 *
 * A request that can only be answered by a model, with no model anywhere, is
 * refused with the reason. It is never answered with `{}`.
 */

import { fetchDocument } from './fetcher.js';
import { htmlToMarkdown } from './markdown.js';
import { chatJson, describeModel } from './llm.js';
import { parseUrl, assertPublicHost } from './safety.js';
import {
  addWarning,
  expiresAt,
  isExpired,
  newId,
  pruneJobs,
  readJob,
  removeJob,
  snapshot,
  writeJob,
} from './jobs.js';
import * as firecrawl from './firecrawl.js';

const MAX_URLS = 100;
/** What one extraction may read, so a prompt cannot be given a whole site. */
const MAX_CHARS_PER_PAGE = 40_000;
const MAX_CHARS_TOTAL = 160_000;
const MAX_TABLES = 20;
const MAX_ROWS = 200;

const active = new Map();

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: 'E_BAD_REQUEST' });
}

function integer(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function stripTags(html) {
  return String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function walkLd(value) {
  if (Array.isArray(value)) return value.flatMap(walkLd);
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value['@graph'])) return value['@graph'].flatMap(walkLd);
  return [value];
}

function jsonLd(html) {
  const blocks = [];
  for (const match of String(html ?? '').matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const text = match[1].trim();
    if (!text) continue;
    try {
      blocks.push(...walkLd(JSON.parse(text)));
    } catch {
      // A page with one malformed block usually has others that are fine.
    }
  }
  return blocks;
}

function metaTags(html) {
  const openGraph = {};
  const named = {};
  for (const match of String(html ?? '').matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1];
    const content = /\bcontent=["']([^"']*)["']/i.exec(attrs)?.[1];
    if (content === undefined) continue;
    const property = /\bproperty=["']([^"']+)["']/i.exec(attrs)?.[1];
    const name = /\bname=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (property?.startsWith('og:')) openGraph[property.slice(3)] = content;
    else if (property?.startsWith('article:')) openGraph[property] = content;
    else if (name) named[name.toLowerCase()] = content;
  }
  return { openGraph, named };
}

/**
 * Microdata, at the level most pages actually use it: a property name and the
 * value in `content` or in the element's text. RDFa and nested itemscopes exist
 * and are not worth a parser here; JSON-LD covers the same pages better.
 */
function microdata(html) {
  const found = {};
  const source = String(html ?? '');
  for (const match of source.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bitemprop=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const key = match[3].trim().toLowerCase();
    const content = /\bcontent=["']([^"']*)["']/i.exec(match[2])?.[1];
    const value = content !== undefined ? content : stripTags(match[4]);
    if (!value) continue;
    if (found[key] === undefined) found[key] = value;
    else if (Array.isArray(found[key])) found[key].push(value);
    else found[key] = [found[key], value];
  }
  return found;
}

function tables(html) {
  const found = [];
  for (const table of String(html ?? '').matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    if (found.length >= MAX_TABLES) break;
    const rows = [...table[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)]
      .slice(0, MAX_ROWS)
      .map((row) => [...row[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => stripTags(cell[1])))
      .filter((cells) => cells.length);
    if (rows.length) found.push(rows);
  }
  return found;
}

/** Every key a page states, lowered to a form a schema property can match. */
function factMap({ jsonld, openGraph, meta, micro }) {
  const facts = new Map();
  const put = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized || facts.has(normalized)) return;
    facts.set(normalized, value);
  };

  for (const entry of jsonld) {
    for (const [key, value] of Object.entries(entry)) {
      if (key.startsWith('@')) continue;
      put(key, value);
    }
  }
  for (const [key, value] of Object.entries(openGraph)) put(key, value);
  for (const [key, value] of Object.entries(meta)) put(key, value);
  for (const [key, value] of Object.entries(micro)) put(key, value);
  return facts;
}

function coerce(value, schema) {
  const type = schema?.type;
  if (type === 'number' || type === 'integer') {
    const number = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.+-]/g, ''));
    if (!Number.isFinite(number)) return undefined;
    return type === 'integer' ? Math.trunc(number) : number;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    return /^(true|yes|1)$/i.test(String(value).trim());
  }
  if (type === 'array') {
    const list = Array.isArray(value) ? value : [value];
    if (!schema.items) return list;
    return list.map((entry) => coerce(entry, schema.items)).filter((entry) => entry !== undefined);
  }
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return value;
  return String(value);
}

function fillSchema(schema, facts) {
  if (!schema || typeof schema !== 'object') return {};
  const properties = schema.properties ?? {};
  const out = {};
  for (const [key, sub] of Object.entries(properties)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const direct = facts.get(normalized);
    if (direct !== undefined) {
      const value = coerce(direct, sub);
      if (value !== undefined) out[key] = value;
      continue;
    }
    // A nested object is usually a JSON-LD object already in the facts.
    if (sub?.type === 'object' || sub?.properties) {
      const nested = fillSchema(sub, facts);
      const any = Object.values(nested).some((value) => value !== undefined);
      if (any) out[key] = nested;
    }
  }
  return out;
}

function mergeObjects(target, incoming) {
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (Array.isArray(value)) {
      const existing = Array.isArray(target[key]) ? target[key] : (target[key] === undefined ? [] : [target[key]]);
      const seen = new Set(existing.map((entry) => JSON.stringify(entry)));
      for (const entry of value) {
        const marker = JSON.stringify(entry);
        if (!seen.has(marker)) {
          seen.add(marker);
          existing.push(entry);
        }
      }
      target[key] = existing;
    } else if (value && typeof value === 'object') {
      target[key] = mergeObjects(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
    } else if (target[key] === undefined) {
      target[key] = value;
    }
  }
  return target;
}

/**
 * The deterministic reader over markup already in hand, shaped by a schema.
 *
 * Shared with `scrape`: a `json` format with a schema and no model is answered
 * from JSON-LD, microdata, OpenGraph, meta tags and tables, which is the same
 * promise `extract` makes and should not be implemented twice.
 */
export function structuredFromHtml(html, schema) {
  const { openGraph, named } = metaTags(html);
  const ld = jsonLd(html);
  const micro = microdata(html);
  const facts = factMap({ jsonld: ld, openGraph, meta: named, micro });
  if (schema) return fillSchema(schema, facts);
  return {
    jsonld: ld,
    openGraph,
    meta: named,
    microdata: micro,
    tables: tables(html),
  };
}

/** Reads one page and returns both what a schema wants and what the page says. */
async function readPage(url, config) {
  const result = await fetchDocument(url, {
    mode: 'raw',
    timeout_ms: config.timeoutMs ?? 12_000,
    max_bytes: config.maxBodyBytes,
    follow_redirects: true,
    respect_robots: true,
    include_links: false,
    include_images: false,
  }, config);

  const html = result.document.raw ?? '';
  const markdown = result.document.markdown ?? htmlToMarkdown(html);
  const { openGraph, named } = metaTags(html);
  const ld = jsonLd(html);
  const micro = microdata(html);
  return {
    url: result.retrieval.final_url,
    title: result.document.metadata?.title ?? openGraph.title ?? null,
    description: result.document.metadata?.description ?? openGraph.description ?? null,
    markdown,
    facts: factMap({ jsonld: ld, openGraph, meta: named, micro }),
    rich: {
      jsonld: ld,
      openGraph,
      meta: named,
      microdata: micro,
      tables: tables(html),
    },
  };
}

function deterministicData(pages, schema) {
  const merged = {};
  for (const page of pages) {
    const shaped = schema ? fillSchema(schema, page.facts) : {
      url: page.url,
      title: page.title,
      description: page.description,
      ...page.rich,
    };
    mergeObjects(merged, shaped);
  }
  return merged;
}

function pageContext(pages) {
  let total = 0;
  const parts = [];
  for (const page of pages) {
    const text = page.markdown.slice(0, MAX_CHARS_PER_PAGE);
    if (!text) continue;
    if (total + text.length > MAX_CHARS_TOTAL) break;
    total += text.length;
    parts.push(`### ${page.url}\n${text}`);
  }
  return parts.join('\n\n');
}

async function runExtract(runtime, config) {
  const { job } = runtime;
  const pages = [];

  try {
    const results = await Promise.allSettled(job.urls.map(async (url) => {
      if (runtime.cancelled) return null;
      return readPage(url, config);
    }));

    for (const [index, outcome] of results.entries()) {
      if (outcome.status === 'fulfilled' && outcome.value) pages.push(outcome.value);
      else if (outcome.status === 'rejected') addWarning(job, `${job.urls[index]}: ${outcome.reason?.message ?? outcome.reason}`);
    }

    if (!pages.length) {
      throw Object.assign(new Error('none of the URLs could be read'), { status: 502, code: 'E_FETCH' });
    }
    if (runtime.cancelled) {
      job.status = 'cancelled';
      job.completedAt = new Date().toISOString();
      return;
    }

    const wantsModel = Boolean(job.prompt || job.schema);
    const model = wantsModel ? await describeModel(config) : null;

    if (wantsModel && !model && config.firecrawlApiKey) {
      const forwarded = await firecrawl.extract({
        urls: job.urls,
        prompt: job.prompt ?? undefined,
        schema: job.schema ?? undefined,
        showSources: job.showSources,
      }, config);
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.upstream = { id: forwarded.id, base: config.firecrawlApiUrl };
      job.data = forwarded;
      writeJob(config, 'extract', job);
      return;
    }

    if (wantsModel && !model) {
      // The deterministic reader still answers a schema from structured markup;
      // only a free-form prompt genuinely needs a model.
      if (job.prompt) {
        throw Object.assign(new Error('this extract needs a model: start Ollama, set OPENAI_API_KEY, or provide a Firecrawl key; extraction without a prompt works here'), {
          status: 501,
          code: 'E_NO_LLM',
        });
      }
      job.data = deterministicData(pages, job.schema);
    } else if (model) {
      const text = pageContext(pages);
      const answer = await chatJson({
        system: 'You extract facts from web pages. Use only the text provided. Never invent a value: omit a field the pages do not state.',
        prompt: `${job.prompt ?? 'Extract the data described by the schema from these pages.'}\n\n${text}`,
        schema: job.schema ?? undefined,
        config,
      });
      job.data = answer.json;
      job.tokensUsed = answer.tokensUsed;
      job.model = `${answer.provider}:${answer.model}`;
    } else {
      job.data = deterministicData(pages, job.schema);
    }

    if (job.showSources) job.sources = pages.map((page) => ({ url: page.url, title: page.title }));
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.duration = Date.now() - Date.parse(job.createdAt);
    writeJob(config, 'extract', job);
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    try {
      writeJob(config, 'extract', job);
    } catch {
      // The status endpoint still reports the failure from memory.
    }
  }
}

/**
 * POST /v2/extract.
 *
 * Always asynchronous, as upstream is: a page read plus a model call outlives
 * a comfortable request, and polling is the shape every client already has.
 */
export async function v2ExtractStart(body = {}, config = {}) {
  const raw = body.urls ?? (body.url ? [body.url] : []);
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('urls must be a non-empty array');
  if (raw.length > MAX_URLS) throw badRequest(`urls is limited to ${MAX_URLS} entries`);

  const ignoreInvalid = body.ignoreInvalidURLs !== false;
  const invalidURLs = [];
  const urls = [];
  const seen = new Set();
  for (const entry of raw) {
    const url = String(entry ?? '').trim();
    let ok = false;
    try {
      parseUrl(url);
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok) {
      if (!ignoreInvalid) throw badRequest(`invalid URL: ${url || '(empty)'}`);
      invalidURLs.push(url);
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  if (!urls.length) throw badRequest('urls contained no usable URL');

  if (body.schema !== undefined && (typeof body.schema !== 'object' || body.schema === null)) {
    throw badRequest('schema must be a JSON Schema object');
  }

  // Checked before a job exists, so a private address is a refusal and not a
  // job that quietly fails to read anything.
  for (const url of urls.slice(0, 5)) await assertPublicHost(parseUrl(url));

  const id = newId('extract');
  const job = {
    id,
    urls,
    prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : null,
    schema: body.schema ?? null,
    showSources: body.showSources === true,
    status: 'processing',
    createdAt: new Date().toISOString(),
    warnings: [],
    webhook: typeof body.webhook === 'string' ? body.webhook : null,
    timeout: integer(body.timeout, 1_000, 120_000, config.timeoutMs ?? 12_000),
  };

  pruneJobs(config, 'extract');
  const runtime = { job, cancelled: false };
  active.set(id, runtime);
  writeJob(config, 'extract', snapshot(job));

  runtime.finished = runExtract(runtime, config).finally(() => active.delete(id));

  return {
    success: true,
    id,
    ...(invalidURLs.length ? { invalidURLs } : {}),
  };
}

/**
 * GET /v2/extract/:id.
 *
 * A job that was forwarded upstream is re-read upstream: the model ran there,
 * so the answer is theirs to report rather than something to copy on arrival.
 */
export async function v2ExtractStatus(id, config = {}) {
  const runtime = active.get(id);
  const job = runtime?.job ?? readJob(config, 'extract', id);
  if (!job) return { status: 404, json: { success: false, error: 'Extract job not found' } };
  if (isExpired(job)) {
    removeJob(config, 'extract', id);
    return { status: 404, json: { success: false, error: 'Extract job not found' } };
  }

  if (job.upstream) {
    try {
      const upstream = await firecrawl.extractStatus(job.upstream.id, config);
      return { status: 200, json: upstream };
    } catch (error) {
      return {
        status: 502,
        json: { success: false, status: 'failed', error: `the keyed extract could not be read: ${error.message}`, expiresAt: expiresAt(job) },
      };
    }
  }

  const body = {
    success: job.status !== 'failed',
    status: job.status,
    data: job.data ?? (job.status === 'processing' ? {} : []),
    expiresAt: expiresAt(job),
    ...(job.error ? { error: job.error } : {}),
    ...(job.tokensUsed ? { tokensUsed: job.tokensUsed } : {}),
    ...(job.model ? { model: job.model } : {}),
    ...(job.sources ? { sources: job.sources } : {}),
    ...(job.warnings?.length ? { warning: job.warnings.join('; ') } : {}),
  };
  return { status: 200, json: body };
}

/** DELETE /v2/extract/:id. */
export function v2ExtractCancel(id, config = {}) {
  const runtime = active.get(id);
  if (runtime) {
    runtime.cancelled = true;
    runtime.job.status = 'cancelled';
    runtime.job.completedAt = new Date().toISOString();
    return { status: 200, json: { success: true } };
  }
  const job = readJob(config, 'extract', id);
  if (!job || isExpired(job)) {
    return { status: 404, json: { success: false, error: 'Extract job not found' } };
  }
  return { status: 200, json: { success: true } };
}
