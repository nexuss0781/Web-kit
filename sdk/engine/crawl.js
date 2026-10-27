/**
 * POST /v2/crawl   GET /v2/crawl/:id   DELETE /v2/crawl/:id
 *
 * A crawl is a map plus a scrape: find the pages a site publishes, then read
 * the ones in scope until the caller's limit is met.
 *
 * It is asynchronous because that is the shape Firecrawl documents, and because
 * a crawl outlives an HTTP request in every real use: the caller starts it,
 * polls, and reads the documents as they arrive. Job state is a JSON file under
 * the data directory, so `webkit stop` followed by a status request the next
 * morning still answers. A job whose worker died with the process is reported
 * as failed rather than left claiming to be scraping forever -- a status that
 * never changes is worse than a failure.
 *
 * Scope is decided once, in `discovery.js`, so a crawl and a map of the same
 * seed cannot disagree about what belongs to the site. Every page is read
 * through `v2Scrape`, so a crawl document is exactly the document a scrape of
 * that URL returns.
 */

import { v2Scrape, PRODUCIBLE, formatsOf } from './compat.js';
import { permitted } from './robots.js';
import { parseUrl, assertPublicHost } from './safety.js';
import {
  absoluteUrl,
  normalizeUrl,
  pathAllowed,
  pathWithin,
  sameSite,
  sitemapUrls,
} from './discovery.js';
import {
  addWarning,
  documentJobStatus,
  isExpired,
  newId,
  pruneJobs,
  readJob,
  removeJob,
  snapshot,
  statusUrl,
  writeJob,
} from './jobs.js';

const DEFAULT_LIMIT = 1_000;
const MAX_LIMIT = 10_000;
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 20;
/** A path can be deep; this is a guard against a link cycle that never ends. */
const MAX_DEPTH = 25;
/** How often progress is written while pages are still arriving. */
const PROGRESS_MS = 2_000;

/** Jobs whose worker is in this process. A job on disk without one has stopped. */
const active = new Map();

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: 'E_BAD_REQUEST' });
}

function list(value) {
  return [].concat(value ?? []).map((entry) => String(entry)).filter(Boolean);
}

function integer(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Turns a stored record whose worker is gone into the failure it really is. */
function reconcile(stored) {
  if (stored.status !== 'scraping' && stored.status !== 'queued') return stored;
  stored.status = 'failed';
  stored.error ??= 'the crawl stopped when the service did; start it again';
  stored.completedAt ??= new Date().toISOString();
  return stored;
}

/**
 * One page in, one document and its links out.
 *
 * Links are always requested from the scrape, because the frontier is built
 * from them; they are removed from the document again when the caller did not
 * ask for that format, so the response is what the request named.
 */
async function processPage(runtime, entry, config) {
  const { job } = runtime;
  const options = job.crawlerOptions;
  const agent = config.userAgent || 'Web-Kit/0.1 (+https://github.com/nexuss0781/Web-kit)';
  const timeout = job.scrapeOptions.timeout ?? config.timeoutMs ?? 12_000;

  try {
    if (!options.ignoreRobotsTxt) {
      const allowed = await permitted(entry.url, agent, timeout);
      if (!allowed) {
        addWarning(job, `skipped ${entry.url}: robots.txt disallows it`);
        return;
      }
    }

    const result = await v2Scrape({ url: entry.url, formats: job.fetchFormats, timeout }, config);
    const document = result.data;
    const links = Array.isArray(document.links) ? document.links : [];
    if (!job.wantsLinks) delete document.links;
    job.data.push(document);

    const atDepthLimit = options.maxDiscoveryDepth !== undefined
      && entry.depth >= options.maxDiscoveryDepth;
    if (atDepthLimit || runtime.seen.size >= options.limit) return;

    const finalUrl = document.metadata?.sourceURL ?? entry.url;
    for (const link of links) {
      const found = absoluteUrl(link, finalUrl);
      if (!found || runtime.seen.size >= options.limit) continue;
      if (!runtime.inScope(found)) continue;
      runtime.admit(found, entry.depth + 1);
    }
  } catch (error) {
    addWarning(job, `${entry.url}: ${error.message}`);
  }
}

async function runCrawl(runtime, config) {
  const { job } = runtime;
  const options = job.crawlerOptions;
  const limit = options.limit;
  const startedAt = Date.now();
  let completed = 0;
  let started = 0;
  let lastWrite = Date.now();

  const flush = () => {
    job.completed = completed;
    job.total = runtime.seen.size;
    writeJob(config, 'crawl', snapshot(job));
    lastWrite = Date.now();
  };

  job.data = [];
  job.total = runtime.seen.size;

  await seedFromSitemap(runtime, config);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const worker = async () => {
    while (true) {
      if (runtime.cancelled) return;
      if (started >= limit) return;
      const entry = runtime.queue.shift();
      if (!entry) {
        // An empty queue while another page is in flight is not the end: that
        // page may still add links. Only an empty queue and nothing in flight is.
        if (runtime.pending === 0) return;
        await sleep(25);
        continue;
      }
      runtime.pending += 1;
      started += 1;
      try {
        await processPage(runtime, entry, config);
      } finally {
        runtime.pending -= 1;
        completed += 1;
        // Counters are kept live in memory so a poll neither waits for the next
        // disk write nor reads a figure that is minutes old.
        job.completed = completed;
        job.total = runtime.seen.size;
      }
      if (options.delay > 0) await sleep(options.delay * 1_000);
      if (Date.now() - lastWrite > PROGRESS_MS) flush();
    }
  };

  await Promise.all(Array.from({ length: job.maxConcurrency }, worker));

  job.status = runtime.cancelled ? 'cancelled' : 'completed';
  job.completed = completed;
  job.total = runtime.seen.size;
  job.completedAt = new Date().toISOString();
  job.duration = Date.now() - startedAt;
  writeJob(config, 'crawl', job);
}

/**
 * POST /v2/crawl.
 *
 * Answers with the id and the status URL, then crawls in the background. The
 * seed is checked before the answer, so an address this service refuses is a
 * refusal and not a job that fails a second later.
 */
export async function v2CrawlStart(body = {}, config = {}) {
  const seed = String(body.url ?? '').trim();
  if (!seed) throw badRequest('url is required');
  await assertPublicHost(parseUrl(seed));

  const scrapeOptions = body.scrapeOptions ?? {};
  // Formats keep their objects: `{ type: 'json', schema }` carries the schema,
  // and a crawl that reduced it to the string 'json' would ask for structured
  // data with nothing to structure it by.
  const requestedFormats = (scrapeOptions.formats ?? body.formats) ?? ['markdown'];
  const formatList = (Array.isArray(requestedFormats) ? requestedFormats : [requestedFormats]).filter(Boolean);
  const wanted = formatsOf({ formats: formatList });
  const unsupported = [...wanted].filter((format) => !PRODUCIBLE.has(format));
  if (unsupported.length) {
    throw badRequest(`format ${unsupported.map((f) => `'${f}'`).join(', ')} is not produced by this deployment; available formats are ${[...PRODUCIBLE].join(', ')}`);
  }

  const sitemap = String(body.sitemap ?? 'include');
  if (!['include', 'skip', 'only'].includes(sitemap)) {
    throw badRequest("sitemap must be 'include', 'skip' or 'only'");
  }

  const id = newId('crawl');
  const now = new Date().toISOString();
  const limit = integer(body.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);

  const job = {
    id,
    url: seed,
    status: 'scraping',
    completed: 0,
    total: 0,
    createdAt: now,
    warnings: [],
    webhook: typeof body.webhook === 'string' ? body.webhook : null,
    crawlerOptions: {
      limit,
      includePaths: list(body.includePaths),
      excludePaths: list(body.excludePaths),
      maxDiscoveryDepth: body.maxDiscoveryDepth === undefined || body.maxDiscoveryDepth === null
        ? undefined
        : integer(body.maxDiscoveryDepth, 0, MAX_DEPTH, MAX_DEPTH),
      crawlEntireDomain: body.crawlEntireDomain === true,
      allowExternalLinks: body.allowExternalLinks === true,
      allowSubdomains: body.allowSubdomains === true,
      ignoreRobotsTxt: body.ignoreRobotsTxt === true,
      sitemap,
      ignoreQueryParameters: body.ignoreQueryParameters === true,
      regexOnFullURL: body.regexOnFullURL === true,
      delay: integer(body.delay, 0, 60, 0),
    },
    // The union of what the caller asked to see and what the frontier needs.
    fetchFormats: wanted.has('links') ? formatList : [...formatList, 'links'],
    wantsLinks: wanted.has('links'),
    scrapeOptions: {
      formats: formatList,
      timeout: integer(scrapeOptions.timeout ?? scrapeOptions.timeout_ms ?? body.timeout, 100, 60_000, config.timeoutMs ?? 12_000),
    },
    maxConcurrency: integer(body.maxConcurrency, 1, MAX_CONCURRENCY, DEFAULT_CONCURRENCY),
    zeroDataRetention: body.zeroDataRetention === true,
    origin: body.origin ?? null,
  };

  pruneJobs(config, 'crawl');
  const runtime = runtimeFor(job);
  writeJob(config, 'crawl', snapshot(job));

  runtime.finished = runCrawl(runtime, config).catch((error) => {
    job.status = 'failed';
    job.error = error.message ?? String(error);
    job.completedAt = new Date().toISOString();
    job.duration = Date.now() - Date.parse(job.createdAt);
    try {
      writeJob(config, 'crawl', job);
    } catch {
      // The status endpoint still reports the failure from memory.
    }
  }).finally(() => {
    active.delete(id);
  });

  return { success: true, id, url: statusUrl(config, 'crawl', id) };
}

/**
 * Builds the in-process state for a job: the frontier, the scope rules, and
 * the admission check every discovered URL goes through.
 *
 * Seed first, then sitemap, then the seed page's own links. The sitemap gets at
 * most half the budget on an ordinary crawl, because a large sitemap would
 * otherwise spend the whole limit before a single link had been followed --
 * which is a map, not a crawl. `sitemap: 'only'` is the exception: there the
 * sitemap is the crawl.
 */
function runtimeFor(job) {
  const options = job.crawlerOptions;
  const seed = job.url;
  const runtime = {
    job,
    cancelled: false,
    pending: 0,
    queue: [],
    seen: new Set(),
    inScope(url) {
      if (!sameSite(url, seed, options.allowSubdomains)) return options.allowExternalLinks;
      if (!pathAllowed(url, options.includePaths, options.excludePaths, { fullUrl: options.regexOnFullURL })) return false;
      if (!options.crawlEntireDomain && !pathWithin(url, seed)) return false;
      return true;
    },
    admit(url, depth) {
      if (runtime.seen.size >= options.limit) return;
      if (depth > MAX_DEPTH) return;
      const normalized = normalizeUrl(url, options.ignoreQueryParameters);
      if (!normalized || runtime.seen.has(normalized)) return;
      runtime.seen.add(normalized);
      runtime.queue.push({ url: normalized, depth });
    },
  };

  runtime.seed = () => {
    if (options.sitemap === 'only') return;
    runtime.admit(seed, 0);
  };
  runtime.seed();
  active.set(job.id, runtime);
  return runtime;
}

/**
 * Adds sitemap pages to the frontier. Called by the worker before it starts so
 * the sitemap's requests are part of the same job, and a sitemap failure is a
 * warning rather than a failed crawl.
 */
async function seedFromSitemap(runtime, config) {
  const { job } = runtime;
  const options = job.crawlerOptions;
  if (options.sitemap === 'skip') return;

  const agent = config.userAgent || 'Web-Kit/0.1 (+https://github.com/nexuss0781/Web-kit)';
  const budget = options.sitemap === 'only'
    ? options.limit
    : Math.max(1, Math.floor(options.limit / 2));

  try {
    const urls = await sitemapUrls(job.url, {
      agent,
      timeoutMs: config.timeoutMs ?? 12_000,
      maxPages: budget,
      config,
      onWarning: (line) => addWarning(job, line),
    });
    for (const url of urls) {
      if (runtime.seen.size >= Math.min(options.limit, budget)) break;
      if (runtime.inScope(url)) runtime.admit(url, 1);
    }
  } catch (error) {
    addWarning(job, `sitemap: ${error.message}`);
  }
}

/**
 * GET /v2/crawl/:id.
 *
 * Reads from memory while the crawl is running and from disk afterwards, so a
 * poll during the crawl sees the documents collected so far and a poll after a
 * restart sees the last state the process wrote.
 */
export function v2CrawlStatus(id, config = {}) {
  const runtime = active.get(id);
  if (runtime) return { status: 200, json: documentJobStatus(runtime.job) };

  const stored = readJob(config, 'crawl', id);
  if (!stored) return { status: 404, json: { success: false, error: 'Crawl not found' } };
  if (isExpired(stored)) {
    removeJob(config, 'crawl', id);
    return { status: 404, json: { success: false, error: 'Crawl not found' } };
  }

  const before = stored.status;
  const reconciled = reconcile(stored);
  if (reconciled.status !== before) {
    try {
      writeJob(config, 'crawl', reconciled);
    } catch {
      // Reporting the failure does not depend on being able to save it.
    }
  }
  return { status: 200, json: documentJobStatus(reconciled) };
}

/** DELETE /v2/crawl/:id. A finished crawl answers success and changes nothing. */
export function v2CrawlCancel(id, config = {}) {
  const runtime = active.get(id);
  if (runtime) {
    runtime.cancelled = true;
    runtime.job.status = 'cancelled';
    runtime.job.completedAt = new Date().toISOString();
    return { status: 200, json: { success: true } };
  }

  const stored = readJob(config, 'crawl', id);
  if (!stored || isExpired(stored)) {
    return { status: 404, json: { success: false, error: 'Crawl not found' } };
  }
  if (stored.status === 'scraping' || stored.status === 'queued') {
    stored.status = 'cancelled';
    stored.completedAt = new Date().toISOString();
    try {
      writeJob(config, 'crawl', stored);
    } catch {
      // Nothing to cancel in this process; the answer is still success.
    }
  }
  return { status: 200, json: { success: true } };
}
