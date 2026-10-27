/**
 * POST /v2/batch/scrape      GET /v2/batch/scrape/:id      DELETE /v2/batch/scrape/:id
 *
 * Scrape a list of known URLs as one job. The shape is the crawl's -- an id, a
 * status URL, progress counters and a document array -- because Firecrawl
 * defines the two responses identically and a client that polls one already
 * knows how to poll the other.
 *
 * The difference is the frontier: there isn't one. The caller named every URL,
 * so the job is a fixed list read at a fixed concurrency, and no link is ever
 * followed. That also means an unreachable URL costs a warning, not the batch.
 */

import { v2Scrape, PRODUCIBLE, formatsOf } from './compat.js';
import { parseUrl } from './safety.js';
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

/** More than this is a crawl, not a list the caller assembled. */
const MAX_URLS = 10_000;
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 20;
const PROGRESS_MS = 2_000;

const active = new Map();

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: 'E_BAD_REQUEST' });
}

function integer(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function syntaxOk(value) {
  try {
    parseUrl(value);
    return true;
  } catch {
    return false;
  }
}

function reconcile(stored) {
  if (stored.status !== 'scraping' && stored.status !== 'queued') return stored;
  stored.status = 'failed';
  stored.error ??= 'the batch stopped when the service did; start it again';
  stored.completedAt ??= new Date().toISOString();
  return stored;
}

async function runBatch(runtime, config) {
  const { job } = runtime;
  let next = 0;
  let completed = 0;
  let lastWrite = Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const flush = () => {
    job.completed = completed;
    writeJob(config, 'batch', snapshot(job));
    lastWrite = Date.now();
  };

  const worker = async () => {
    while (true) {
      if (runtime.cancelled) return;
      const index = next;
      next += 1;
      if (index >= job.urls.length) return;

      const url = job.urls[index];
      try {
        const result = await v2Scrape({ url, formats: job.formats, timeout: job.timeout }, config);
        // Written at its request position so the array follows the caller's
        // list rather than the order the network happened to answer in.
        job.data[index] = result.data;
      } catch (error) {
        addWarning(job, `${url}: ${error.message}`);
      } finally {
        completed += 1;
        job.completed = completed;
      }
      if (Date.now() - lastWrite > PROGRESS_MS) flush();
      if (job.delay > 0) await sleep(job.delay * 1_000);
    }
  };

  await Promise.all(Array.from({ length: job.maxConcurrency }, worker));

  job.status = runtime.cancelled ? 'cancelled' : 'completed';
  job.completed = completed;
  job.completedAt = new Date().toISOString();
  job.duration = Date.now() - Date.parse(job.createdAt);
  writeJob(config, 'batch', job);
}

/**
 * POST /v2/batch/scrape.
 *
 * `ignoreInvalidURLs` defaults to true, as it does upstream: a list assembled
 * by an agent is one bad entry away from returning nothing, and reporting the
 * bad entries beside the job is more useful than refusing the whole batch.
 */
export async function v2BatchStart(body = {}, config = {}) {
  const raw = body.urls;
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('urls must be a non-empty array');
  if (raw.length > MAX_URLS) throw badRequest(`urls is limited to ${MAX_URLS} entries per batch`);

  const wanted = formatsOf(body);
  const unsupported = [...wanted].filter((format) => !PRODUCIBLE.has(format));
  if (unsupported.length) {
    throw badRequest(`format ${unsupported.map((f) => `'${f}'`).join(', ')} is not produced by this deployment; available formats are ${[...PRODUCIBLE].join(', ')}`);
  }

  const ignoreInvalid = body.ignoreInvalidURLs !== false;
  const invalidURLs = [];
  const urls = [];
  const seen = new Set();
  for (const entry of raw) {
    const url = String(entry ?? '').trim();
    if (!syntaxOk(url)) {
      if (!ignoreInvalid) throw badRequest(`invalid URL: ${url || '(empty)'}`);
      invalidURLs.push(url);
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  if (!urls.length) throw badRequest('urls contained no usable URL');

  const id = newId('batch');
  const job = {
    id,
    status: 'scraping',
    completed: 0,
    total: urls.length,
    createdAt: new Date().toISOString(),
    warnings: [],
    webhook: typeof body.webhook === 'string' ? body.webhook : null,
    urls,
    data: [],
    formats: [...wanted],
    timeout: integer(body.timeout ?? body.timeout_ms, 100, 60_000, config.timeoutMs ?? 12_000),
    maxConcurrency: integer(body.maxConcurrency, 1, MAX_CONCURRENCY, DEFAULT_CONCURRENCY),
    delay: integer(body.delay, 0, 60, 0),
    zeroDataRetention: body.zeroDataRetention === true,
  };

  pruneJobs(config, 'batch');
  const runtime = { job, cancelled: false };
  active.set(id, runtime);
  writeJob(config, 'batch', snapshot(job));

  runtime.finished = runBatch(runtime, config).catch((error) => {
    job.status = 'failed';
    job.error = error.message ?? String(error);
    job.completedAt = new Date().toISOString();
    try {
      writeJob(config, 'batch', job);
    } catch {
      // The status endpoint still reports the failure from memory.
    }
  }).finally(() => {
    active.delete(id);
  });

  return {
    success: true,
    id,
    url: statusUrl(config, 'batch/scrape', id),
    ...(invalidURLs.length ? { invalidURLs } : {}),
  };
}

/** GET /v2/batch/scrape/:id. */
export function v2BatchStatus(id, config = {}) {
  const runtime = active.get(id);
  if (runtime) return { status: 200, json: documentJobStatus(runtime.job) };

  const stored = readJob(config, 'batch', id);
  if (!stored) return { status: 404, json: { success: false, error: 'Batch scrape not found' } };
  if (isExpired(stored)) {
    removeJob(config, 'batch', id);
    return { status: 404, json: { success: false, error: 'Batch scrape not found' } };
  }

  const before = stored.status;
  const reconciled = reconcile(stored);
  if (reconciled.status !== before) {
    try {
      writeJob(config, 'batch', reconciled);
    } catch {
      // Reporting the failure does not depend on being able to save it.
    }
  }
  return { status: 200, json: documentJobStatus(reconciled) };
}

/** DELETE /v2/batch/scrape/:id. */
export function v2BatchCancel(id, config = {}) {
  const runtime = active.get(id);
  if (runtime) {
    runtime.cancelled = true;
    runtime.job.status = 'cancelled';
    runtime.job.completedAt = new Date().toISOString();
    return { status: 200, json: { success: true } };
  }

  const stored = readJob(config, 'batch', id);
  if (!stored || isExpired(stored)) {
    return { status: 404, json: { success: false, error: 'Batch scrape not found' } };
  }
  if (stored.status === 'scraping' || stored.status === 'queued') {
    stored.status = 'cancelled';
    stored.completedAt = new Date().toISOString();
    try {
      writeJob(config, 'batch', stored);
    } catch {
      // Nothing to cancel in this process; the answer is still success.
    }
  }
  return { status: 200, json: { success: true } };
}
