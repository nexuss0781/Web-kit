/**
 * Job files for the asynchronous endpoints.
 *
 * Firecrawl answers `crawl`, `batch/scrape`, `extract` and `monitor` with an id
 * and a status URL. There is no queue here, so the job's state is a JSON file
 * under the data directory: a daemon restart, or `webkit stop` followed by a
 * search an hour later, loses nothing that a status request would have returned.
 *
 * Two rules keep the files honest:
 *
 * - An id from a URL is used in a path, so it is checked against a conservative
 *   alphabet before it is ever joined to a directory. `../../config.json` is a
 *   perfectly valid route parameter.
 * - A write lands with a rename, so a status request that arrives mid-write
 *   reads the previous file rather than half of the next one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** A conservative id, which is also what makes it safe as a file name. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

export function dataHome(config = {}) {
  return config.dataDir || path.join(os.homedir(), '.webkit');
}

export function jobsDir(config, kind) {
  return path.join(dataHome(config), 'jobs', kind);
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function validId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function jobPath(config, kind, id) {
  return path.join(jobsDir(config, kind), `${id}.json`);
}

export function readJob(config, kind, id) {
  if (!validId(id)) return null;
  try {
    const job = JSON.parse(fs.readFileSync(jobPath(config, kind, id), 'utf8'));
    // A file that names a different job than the path did is not this job.
    return job?.id === id ? job : null;
  } catch {
    return null;
  }
}

export function writeJob(config, kind, job) {
  if (!validId(job?.id)) throw new Error('a job needs a safe id before it can be stored');
  const dir = jobsDir(config, kind);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${job.id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(job));
  fs.renameSync(temporary, target);
}

export function removeJob(config, kind, id) {
  if (!validId(id)) return false;
  try {
    fs.rmSync(jobPath(config, kind, id), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function listJobs(config, kind) {
  let names;
  try {
    names = fs.readdirSync(jobsDir(config, kind));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJob(config, kind, name.slice(0, -'.json'.length)))
    .filter(Boolean);
}

/**
 * Deletes jobs that are past the 24-hour window their status URLs promise.
 * Called when a new job starts, which is the one moment the directory is
 * already being written and a scan costs nothing.
 */
export function pruneJobs(config, kind, maxAgeMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  for (const job of listJobs(config, kind)) {
    const createdAt = Date.parse(job.createdAt ?? '') || 0;
    if (now - createdAt > maxAgeMs) removeJob(config, kind, job.id);
  }
}

/** Every async job in this service is readable for a day, as Firecrawl's are. */
export function expiresAt(job) {
  return new Date((Date.parse(job.createdAt ?? '') || Date.now()) + 24 * 60 * 60 * 1000).toISOString();
}

export function isExpired(job) {
  return Date.now() > Date.parse(expiresAt(job));
}

/**
 * The address a status URL should name.
 *
 * Loopback is right for the daemon the SDK runs, and wrong for anything behind
 * a proxy, so `WEBKIT_PUBLIC_URL` wins when it is set.
 */
export function statusUrl(config, path, id) {
  const base = config.publicUrl || `http://127.0.0.1:${config.port ?? 3000}`;
  return `${base}/v2/${path}/${id}`;
}

/** How many distinct failures a status response quotes before it summarises. */
const MAX_WARNINGS = 25;

export function addWarning(job, message) {
  job.warnings ??= [];
  if (job.warnings.length < MAX_WARNINGS) job.warnings.push(message);
  else if (job.warnings.length === MAX_WARNINGS) job.warnings.push('further warnings were dropped');
}

/**
 * The persisted form of a running job.
 *
 * The document array is left out on purpose: a hundred-page crawl would
 * otherwise rewrite every document it had collected on every page, which is
 * quadratic I/O for a status file. It is written once when the job finishes,
 * which is also the only time a later process needs it.
 */
export function snapshot(job) {
  const { data, ...rest } = job;
  return { ...rest, dataCount: Array.isArray(data) ? data.length : 0 };
}

/**
 * The status shape of `crawl` and `batch/scrape`, which Firecrawl defines
 * identically: progress counters, a document array and a 24-hour expiry.
 */
export function documentJobStatus(job) {
  const body = {
    success: true,
    status: job.status,
    completed: job.completed ?? 0,
    total: job.total ?? 0,
    creditsUsed: 0,
    expiresAt: expiresAt(job),
    createdAt: job.createdAt,
    data: (job.data ?? []).filter(Boolean),
  };
  if (job.completedAt) body.completedAt = job.completedAt;
  if (job.duration !== undefined) body.duration = job.duration;
  if (job.error) body.error = job.error;

  const notes = [
    Array.isArray(job.warnings) && job.warnings.length ? job.warnings.join('; ') : null,
    // Webhooks are part of Firecrawl's request shape and are accepted, but this
    // deployment has nowhere to deliver one. Saying so on every read is better
    // than a caller waiting for a callback that will never come.
    job.webhook ? 'webhooks are not delivered by this deployment' : null,
  ].filter(Boolean);
  if (notes.length) body.warning = notes.join('; ');
  return body;
}

