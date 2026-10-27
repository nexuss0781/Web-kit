/**
 * /v2/monitor — watch a set of pages and report what changed.
 *
 * A monitor is a schedule, a list of things to read, and a memory of what they
 * said last time. Each run is a *check*: every page is read again, compared to
 * the previous snapshot of that page, and labelled `same`, `new`, `changed`,
 * `removed` or `error`. That vocabulary is Firecrawl's, and it is the right
 * one: a boolean "changed" throws away the fact that a page appeared or died.
 *
 * Storage is two things on disk, both JSON: the monitor list, and per-monitor
 * checks plus a snapshot of the last text seen for each URL. Nothing here needs
 * a database, a worker process or a network service, which is what keeps the
 * whole product one command in a terminal.
 *
 * Three target kinds:
 *
 * - `scrape`: a fixed list of URLs.
 * - `crawl`: map a site and watch the pages within the caller's limit.
 * - `search`: run queries and watch the results, which is how a monitor
 *   notices something that did not exist at the address it was given.
 *
 * Schedules are validated by `schedule.js`: cron or a phrase, UTC, and no
 * faster than every five minutes. A check aggregates a page per URL, so a
 * monitor that ran every minute would be a scraper with extra steps.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataHome } from './jobs.js';
import { nextRunAt, validateSchedule, estimateRunsPerMonth } from './schedule.js';
import { fetchDocument } from './fetcher.js';
import { v2Map } from './map.js';
import { v2Scrape, v2Search } from './compat.js';
import { parseUrl, assertPublicHost } from './safety.js';

const MAX_TARGETS = 50;
const MAX_TARGET_URLS = 50;
const MAX_SEARCH_RESULTS = 50;
/** What one check may read, across every target, so a check stays bounded. */
const MAX_PAGES_PER_CHECK = 200;
const MAX_TEXT_BYTES = 400_000;
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 5_000;

let ticking = false;
let timer = null;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: 'E_BAD_REQUEST' });
}

function notFound(message = 'Monitor not found') {
  return Object.assign(new Error(message), { status: 404, code: 'E_NOT_FOUND' });
}

function integer(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function monitorsFile(config) {
  return path.join(dataHome(config), 'monitors.json');
}

function checksDir(config, monitorId) {
  return path.join(dataHome(config), 'monitor-checks', monitorId);
}

function snapshotsFile(config, monitorId) {
  return path.join(dataHome(config), 'monitor-snapshots', `${monitorId}.json`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic: a monitor list half-written is a monitor list lost. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

export function readMonitors(config) {
  const list = readJson(monitorsFile(config), []);
  return Array.isArray(list) ? list : [];
}

function writeMonitors(config, list) {
  writeJson(monitorsFile(config), list);
}

function readChecks(config, monitorId) {
  let names;
  try {
    names = fs.readdirSync(checksDir(config, monitorId));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(checksDir(config, monitorId), name), null))
    .filter(Boolean);
}

function writeCheck(config, check) {
  writeJson(path.join(checksDir(config, check.monitorId), `${check.id}.json`), check);
}

function readSnapshot(config, monitorId) {
  const value = readJson(snapshotsFile(config, monitorId), {});
  return value && typeof value === 'object' ? value : {};
}

function writeSnapshot(config, monitorId, snapshot) {
  writeJson(snapshotsFile(config, monitorId), snapshot);
}

function normalizeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
}

function requireMonitor(config, id) {
  if (!normalizeId(id)) throw notFound();
  const monitor = readMonitors(config).find((entry) => entry.id === id);
  if (!monitor) throw notFound();
  return monitor;
}

function saveMonitor(config, monitor) {
  const monitors = readMonitors(config);
  const index = monitors.findIndex((entry) => entry.id === monitor.id);
  monitor.updatedAt = new Date().toISOString();
  if (index === -1) monitors.push(monitor);
  else monitors[index] = monitor;
  writeMonitors(config, monitors);
  return monitor;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

function normalizeTarget(target, index) {
  if (!target || typeof target !== 'object') throw badRequest(`targets[${index}] must be an object`);
  const type = String(target.type ?? '');
  const id = typeof target.id === 'string' && target.id ? target.id : newId('target');

  if (type === 'scrape') {
    const urls = [].concat(target.urls ?? []).map((entry) => String(entry ?? '').trim()).filter(Boolean);
    if (!urls.length) throw badRequest(`targets[${index}].urls must be a non-empty array`);
    if (urls.length > MAX_TARGET_URLS) throw badRequest(`targets[${index}].urls is limited to ${MAX_TARGET_URLS}`);
    for (const url of urls) {
      try {
        parseUrl(url);
      } catch (error) {
        throw badRequest(`targets[${index}].urls: ${error.message}`);
      }
    }
    return { id, type, urls };
  }

  if (type === 'crawl') {
    const url = String(target.url ?? '').trim();
    if (!url) throw badRequest(`targets[${index}].url must be a URL`);
    try {
      parseUrl(url);
    } catch (error) {
      throw badRequest(`targets[${index}].url: ${error.message}`);
    }
    return {
      id,
      type,
      url,
      crawlOptions: {
        limit: integer(target.crawlOptions?.limit, 1, 50, 10),
        includePaths: [].concat(target.crawlOptions?.includePaths ?? []).map(String).filter(Boolean),
        excludePaths: [].concat(target.crawlOptions?.excludePaths ?? []).map(String).filter(Boolean),
      },
    };
  }

  if (type === 'search') {
    const queries = [].concat(target.queries ?? []).map((entry) => String(entry ?? '').trim()).filter(Boolean);
    if (!queries.length) throw badRequest(`targets[${index}].queries must be a non-empty array`);
    if (queries.length > 12) throw badRequest(`targets[${index}].queries is limited to 12`);
    return {
      id,
      type,
      queries,
      searchWindow: ['5m', '15m', '1h', '6h', '24h', '7d'].includes(target.searchWindow) ? target.searchWindow : '24h',
      includeDomains: [].concat(target.includeDomains ?? []).map(String).filter(Boolean),
      excludeDomains: [].concat(target.excludeDomains ?? []).map(String).filter(Boolean),
      maxResults: integer(target.maxResults, 1, MAX_SEARCH_RESULTS, 10),
    };
  }

  throw badRequest(`targets[${index}].type must be 'scrape', 'crawl' or 'search'`);
}

function normalizeTargets(value) {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('targets must be a non-empty array');
  if (value.length > MAX_TARGETS) throw badRequest(`targets is limited to ${MAX_TARGETS}`);
  return value.map(normalizeTarget);
}

function normalizeWebhook(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return { url: value, events: ['monitor.check.completed'] };
  if (typeof value !== 'object' || !value.url) throw badRequest('webhook must be a URL or an object with a url');
  return {
    url: String(value.url),
    events: Array.isArray(value.events) && value.events.length
      ? value.events.map(String)
      : ['monitor.check.completed'],
    ...(value.headers && typeof value.headers === 'object' ? { headers: value.headers } : {}),
  };
}

function normalizeMonitor(body, existing = null) {
  const name = body.name === undefined ? existing?.name : String(body.name ?? '').trim();
  if (!name) throw badRequest('name is required');

  let schedule = existing
    ? { cron: existing.scheduleCron, timezone: existing.scheduleTimezone }
    : null;
  if (body.schedule !== undefined) {
    if (!body.schedule || typeof body.schedule !== 'object') throw badRequest('schedule must be an object');
    const validated = validateSchedule(body.schedule);
    schedule = {
      cron: validated.cron,
      timezone: validated.timezone,
      nextRunAt: validated.nextRunAt.toISOString(),
      intervalMs: validated.intervalMs,
    };
  } else if (existing) {
    const validated = validateSchedule({ cron: existing.scheduleCron, timezone: existing.scheduleTimezone });
    schedule = {
      cron: existing.scheduleCron,
      timezone: existing.scheduleTimezone,
      nextRunAt: existing.nextRunAt,
      intervalMs: validated.intervalMs,
    };
  }
  if (!schedule) throw badRequest('schedule is required');

  const targets = body.targets === undefined
    ? existing?.targets ?? (() => { throw badRequest('targets are required'); })()
    : normalizeTargets(body.targets);

  const hasSearch = targets.some((target) => target.type === 'search');
  const goal = body.goal === undefined ? existing?.goal ?? null : (body.goal === null ? null : String(body.goal).trim() || null);
  // A search monitor without a goal is a list of queries with no definition of
  // "worth telling me about"; upstream refuses it for the same reason.
  if (hasSearch && !goal) throw badRequest('a search target requires a non-empty goal');

  const status = body.status === undefined
    ? existing?.status ?? 'active'
    : (body.status === 'paused' ? 'paused' : 'active');

  return {
    id: existing?.id ?? newId('mon'),
    name,
    status,
    scheduleCron: schedule.cron,
    scheduleTimezone: schedule.timezone,
    nextRunAt: schedule.nextRunAt,
    intervalMs: schedule.intervalMs,
    targets,
    goal,
    judgeEnabled: body.judgeEnabled === undefined ? existing?.judgeEnabled ?? false : body.judgeEnabled === true,
    webhook: body.webhook === undefined ? existing?.webhook ?? null : normalizeWebhook(body.webhook),
    notification: body.notification === undefined ? existing?.notification ?? null : body.notification,
    retentionDays: integer(body.retentionDays ?? existing?.retentionDays, 1, 365, 30),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: existing?.lastRunAt ?? null,
    currentCheckId: existing?.currentCheckId ?? null,
    lastCheckSummary: existing?.lastCheckSummary ?? null,
    estimatedCreditsPerMonth: estimateCredits(schedule.intervalMs, targets),
  };
}

function estimateCredits(intervalMs, targets) {
  const pages = targets.reduce((total, target) => {
    if (target.type === 'scrape') return total + target.urls.length;
    if (target.type === 'crawl') return total + target.crawlOptions.limit;
    return total + target.maxResults * target.queries.length;
  }, 0);
  return estimateRunsPerMonth(intervalMs) * pages;
}

// ---------------------------------------------------------------------------
// Reading a target
// ---------------------------------------------------------------------------

function capText(text) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES) return value;
  return value.slice(0, MAX_TEXT_BYTES);
}

function hashOf(text) {
  return `sha256:${crypto.createHash('sha256').update(String(text ?? '')).digest('hex')}`;
}

async function readScrapeTarget(target, config) {
  const pages = [];
  for (const url of target.urls) {
    try {
      const result = await fetchDocument(url, {
        mode: 'markdown',
        timeout_ms: config.timeoutMs ?? 12_000,
        max_bytes: config.maxBodyBytes,
        follow_redirects: true,
        respect_robots: true,
      }, config);
      const text = capText(result.document.markdown ?? result.document.text ?? '');
      pages.push({
        targetId: target.id,
        url: result.retrieval.final_url,
        title: result.document.metadata?.title ?? null,
        statusCode: result.retrieval.status,
        text,
      });
    } catch (error) {
      pages.push({ targetId: target.id, url, statusCode: null, error: error.message });
    }
  }
  return pages;
}

async function readCrawlTarget(target, config) {
  const pages = [];
  let discovered = [];
  try {
    const mapped = await v2Map({ url: target.url, limit: target.crawlOptions.limit }, config);
    discovered = (mapped.links ?? []).map((entry) => entry.url).slice(0, target.crawlOptions.limit);
  } catch (error) {
    return [{ targetId: target.id, url: target.url, statusCode: null, error: `map: ${error.message}` }];
  }

  for (const url of discovered) {
    try {
      const result = await v2Scrape({ url, formats: ['markdown'] }, config);
      const text = capText(result.data?.markdown ?? '');
      pages.push({
        targetId: target.id,
        url: result.data?.metadata?.sourceURL ?? url,
        title: result.data?.metadata?.title ?? null,
        statusCode: result.data?.metadata?.statusCode ?? 200,
        text,
      });
    } catch (error) {
      pages.push({ targetId: target.id, url, statusCode: null, error: error.message });
    }
  }
  return pages;
}

async function readSearchTarget(target, config) {
  const pages = [];
  const seen = new Set();
  // The stored window is a monitor vocabulary; search takes Google's codes.
  const tbs = target.searchWindow === '7d' ? 'qdr:w'
    : target.searchWindow === '24h' ? 'qdr:d'
      : 'qdr:h';

  for (const query of target.queries) {
    try {
      const result = await v2Search({
        query,
        limit: target.maxResults,
        tbs,
        ...(target.includeDomains.length ? { includeDomains: target.includeDomains } : {}),
        ...(target.excludeDomains.length ? { excludeDomains: target.excludeDomains } : {}),
      }, config);
      for (const item of result.data?.web ?? []) {
        if (!item?.url || seen.has(item.url)) continue;
        seen.add(item.url);
        pages.push({
          targetId: target.id,
          url: item.url,
          title: item.title ?? null,
          statusCode: 200,
          // A search result has no body of its own; its title and snippet are
          // the whole announcement, and they are what a "new result" check
          // should compare.
          text: capText(`${item.title ?? ''}\n${item.description ?? ''}`.trim()),
        });
      }
    } catch (error) {
      pages.push({ targetId: target.id, url: `search:${query}`, statusCode: null, error: error.message });
    }
  }
  return pages;
}

async function readTarget(target, config) {
  if (target.type === 'scrape') return readScrapeTarget(target, config);
  if (target.type === 'crawl') return readCrawlTarget(target, config);
  return readSearchTarget(target, config);
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/**
 * A line diff, tolerant of move: the common prefix and suffix are trimmed and
 * the rest is reported as a removed block and an added block.
 *
 * This is deliberately not a minimal edit script. A monitor's reader wants to
 * see what changed on the page, and a block of `-` lines followed by a block of
 * `+` lines says that more readably than an interleaving of single-line moves.
 */
function diffText(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }

  const lines = [];
  const context = 3;
  for (let index = Math.max(0, start - context); index < start; index += 1) lines.push(` ${a[index]}`);
  for (let index = start; index <= endA; index += 1) lines.push(`-${a[index]}`);
  for (let index = start; index <= endB; index += 1) lines.push(`+${b[index]}`);
  for (let index = endB + 1; index < Math.min(b.length, endB + 1 + context); index += 1) lines.push(` ${b[index]}`);
  return lines.join('\n');
}

function compare(snapshot, pages) {
  const next = {};
  const results = [];
  for (const page of pages) {
    if (page.error) {
      results.push({ ...page, status: 'error' });
      continue;
    }
    const key = page.url;
    const before = snapshot[page.targetId]?.[key];
    const hash = hashOf(page.text);
    let status = 'same';
    let diff;
    if (!before) {
      status = 'new';
    } else if (before.hash !== hash) {
      status = 'changed';
      diff = diffText(before.text, page.text);
    }
    next[page.targetId] ??= {};
    next[page.targetId][key] = { hash, title: page.title ?? null, text: page.text };
    results.push({ ...page, status, ...(diff ? { diff } : {}) });
  }

  // A URL that was there last time and is not there now was removed -- unless
  // it failed this time, in which case the page still exists and the read did
  // not.
  const failed = new Set(results.filter((page) => page.status === 'error').map((page) => `${page.targetId}\n${page.url}`));
  for (const [targetId, pagesByUrl] of Object.entries(snapshot)) {
    for (const [url, before] of Object.entries(pagesByUrl ?? {})) {
      if (next[targetId]?.[url]) continue;
      if (failed.has(`${targetId}\n${url}`)) continue;
      results.push({
        targetId,
        url,
        title: before.title ?? null,
        status: 'removed',
        statusCode: null,
        diff: diffText(before.text, ''),
      });
    }
  }
  return { pages: results, snapshot: next };
}

function summarize(pages) {
  const summary = { total: pages.length, same: 0, new: 0, changed: 0, removed: 0, error: 0 };
  for (const page of pages) summary[page.status] = (summary[page.status] ?? 0) + 1;
  return summary;
}

// ---------------------------------------------------------------------------
// A check
// ---------------------------------------------------------------------------

async function deliverWebhook(monitor, check, config) {
  const hook = monitor.webhook;
  if (!hook?.url) return null;
  // This deployment reports changes per check, not per page; a subscription to
  // page events alone has nothing to receive, and saying so beats silence.
  if (!hook.events.includes('monitor.check.completed')) {
    return { delivered: false, error: 'only the monitor.check.completed event is produced here' };
  }

  try {
    // A webhook URL comes from the caller, so it gets the same check as any
    // other caller-named address before this service posts to it.
    await assertPublicHost(parseUrl(hook.url));
  } catch (error) {
    return { delivered: false, error: `refused webhook address: ${error.message}` };
  }

  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': config.userAgent || 'Web-Kit/0.1',
        ...(hook.headers ?? {}),
      },
      body: JSON.stringify({
        type: 'monitor.check.completed',
        id: check.id,
        monitorId: monitor.id,
        monitorName: monitor.name,
        status: check.status,
        summary: check.summary,
        completedAt: check.completedAt,
      }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return { delivered: response.ok, status: response.status };
  } catch (error) {
    return { delivered: false, error: error.message };
  }
}

/**
 * Runs one check and records it. Never throws: a monitor that fails is a check
 * with `status: 'failed'` and an error, because the next run has to happen
 * regardless.
 */
export async function runCheck(config, monitorId, { trigger = 'manual', scheduledFor = null } = {}) {
  const monitor = requireMonitor(config, monitorId);
  if (monitor.currentCheckId) {
    return { started: false, check: readChecks(config, monitorId).find((entry) => entry.id === monitor.currentCheckId) ?? null };
  }

  const check = {
    id: newId('check'),
    monitorId,
    status: 'running',
    trigger,
    scheduledFor,
    startedAt: new Date().toISOString(),
    completedAt: null,
    pages: [],
    summary: { total: 0, same: 0, new: 0, changed: 0, removed: 0, error: 0 },
  };

  monitor.currentCheckId = check.id;
  monitor.lastRunAt = check.startedAt;
  saveMonitor(config, monitor);
  writeCheck(config, check);

  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  try {
    const snapshot = readSnapshot(config, monitorId);
    const pages = [];
    for (const target of monitor.targets) {
      if (Date.now() > deadline) {
        pages.push({ targetId: target.id, url: target.url ?? 'target', status: 'error', error: 'the check ran out of time' });
        break;
      }
      const read = await readTarget(target, config);
      for (const page of read) {
        if (pages.length >= MAX_PAGES_PER_CHECK) break;
        pages.push(page);
      }
    }

    const compared = compare(snapshot, pages);
    writeSnapshot(config, monitorId, compared.snapshot);

    check.pages = compared.pages.map((page) => ({
      id: newId('page'),
      targetId: page.targetId,
      url: page.url,
      status: page.status,
      title: page.title ?? null,
      statusCode: page.statusCode ?? null,
      error: page.error ?? null,
      diff: page.diff ?? null,
      createdAt: new Date().toISOString(),
    }));
    check.summary = summarize(check.pages);
    check.status = 'completed';
  } catch (error) {
    check.status = 'failed';
    check.error = error.message;
  }

  check.completedAt = new Date().toISOString();
  check.duration = Date.parse(check.completedAt) - Date.parse(check.startedAt);
  writeCheck(config, check);

  const fresh = readMonitors(config).find((entry) => entry.id === monitorId);
  if (fresh) {
    fresh.currentCheckId = null;
    fresh.lastCheckSummary = check.summary;
    fresh.nextRunAt = nextRunAt(fresh.scheduleCron, new Date(check.completedAt)).toISOString();
    saveMonitor(config, fresh);
    check.notificationStatus = { webhook: await deliverWebhook(fresh, check, config) };
    writeCheck(config, check);
    pruneChecks(config, fresh);
  }

  return { started: true, check };
}

function pruneChecks(config, monitor) {
  const cutoff = Date.now() - monitor.retentionDays * 24 * 60 * 60 * 1000;
  const dir = checksDir(config, monitor.id);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const check = readJson(file, null);
    if (!check) continue;
    const ended = Date.parse(check.completedAt ?? check.startedAt ?? '') || Date.now();
    if (ended < cutoff) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // A check that cannot be deleted is not worth failing the run for.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/**
 * Starts the clock. One timer for the whole process, unref'd so a script that
 * uses the library in-process is never kept alive by a monitor it created.
 */
export function startScheduler(config, { tickMs = config.monitorTickMs ?? 30_000 } = {}) {
  if (timer || config.monitorScheduler === false) return false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      for (const monitor of readMonitors(config)) {
        if (monitor.status !== 'active' || monitor.currentCheckId) continue;
        if ((Date.parse(monitor.nextRunAt ?? '') || 0) > now) continue;
        runCheck(config, monitor.id, {
          trigger: 'scheduled',
          scheduledFor: monitor.nextRunAt,
        }).catch(() => {
          // runCheck already records its own failures; this only stops an
          // unhandled rejection from a bug in that bookkeeping.
        });
      }
    } finally {
      ticking = false;
    }
  };
  timer = setInterval(tick, tickMs);
  timer.unref?.();
  tick();
  return true;
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

export function serializeMonitor(monitor) {
  return {
    id: monitor.id,
    name: monitor.name,
    status: monitor.status,
    schedule: { cron: monitor.scheduleCron, timezone: monitor.scheduleTimezone },
    nextRunAt: monitor.nextRunAt,
    lastRunAt: monitor.lastRunAt,
    currentCheckId: monitor.currentCheckId,
    targets: monitor.targets,
    webhook: monitor.webhook,
    notification: monitor.notification,
    retentionDays: monitor.retentionDays,
    estimatedCreditsPerMonth: monitor.estimatedCreditsPerMonth,
    lastCheckSummary: monitor.lastCheckSummary,
    goal: monitor.goal ?? null,
    judgeEnabled: Boolean(monitor.judgeEnabled),
    createdAt: monitor.createdAt,
    updatedAt: monitor.updatedAt,
  };
}

export function v2MonitorCreate(body = {}, config = {}) {
  const monitor = normalizeMonitor(body);
  saveMonitor(config, monitor);
  return { status: 200, json: { success: true, data: serializeMonitor(monitor) } };
}

export function v2MonitorList(query = {}, config = {}) {
  const limit = integer(query.limit, 1, 200, 50);
  const offset = integer(query.offset, 0, 1_000_000, 0);
  const monitors = readMonitors(config).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    status: 200,
    json: { success: true, data: monitors.slice(offset, offset + limit).map(serializeMonitor) },
  };
}

export function v2MonitorGet(id, config = {}) {
  return { status: 200, json: { success: true, data: serializeMonitor(requireMonitor(config, id)) } };
}

export function v2MonitorUpdate(id, body = {}, config = {}) {
  const existing = requireMonitor(config, id);
  const monitor = normalizeMonitor(body, existing);
  // A schedule change means the next run is on the new clock, not the old one.
  if (body.schedule !== undefined) {
    monitor.nextRunAt = nextRunAt(monitor.scheduleCron).toISOString();
  }
  saveMonitor(config, monitor);
  return { status: 200, json: { success: true, data: serializeMonitor(monitor) } };
}

export function v2MonitorDelete(id, config = {}) {
  const monitor = requireMonitor(config, id);
  const monitors = readMonitors(config).filter((entry) => entry.id !== monitor.id);
  writeMonitors(config, monitors);
  try {
    fs.rmSync(checksDir(config, monitor.id), { recursive: true, force: true });
    fs.rmSync(snapshotsFile(config, monitor.id), { force: true });
  } catch {
    // The monitor is gone either way; leftovers expire with the directory.
  }
  return { status: 200, json: { success: true } };
}

export async function v2MonitorRun(id, config = {}) {
  const monitor = requireMonitor(config, id);
  const result = await runCheck(config, monitor.id, { trigger: 'manual' });
  const check = result.check;
  return {
    status: 200,
    json: {
      success: true,
      id: check?.id ?? null,
      data: check ? serializeCheck(check) : null,
    },
  };
}

function serializeCheck(check) {
  return {
    id: check.id,
    monitorId: check.monitorId,
    status: check.status,
    trigger: check.trigger,
    scheduledFor: check.scheduledFor,
    startedAt: check.startedAt,
    completedAt: check.completedAt,
    duration: check.duration ?? null,
    summary: check.summary,
    error: check.error ?? null,
    ...(check.notificationStatus ? { notificationStatus: check.notificationStatus } : {}),
  };
}

export function v2MonitorChecks(id, query = {}, config = {}) {
  requireMonitor(config, id);
  const limit = integer(query.limit, 1, 200, 20);
  const offset = integer(query.offset, 0, 1_000_000, 0);
  const checks = readChecks(config, id)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .filter((check) => !query.status || check.status === query.status);
  return {
    status: 200,
    json: { success: true, data: checks.slice(offset, offset + limit).map(serializeCheck) },
  };
}

export function v2MonitorCheck(id, checkId, query = {}, config = {}) {
  requireMonitor(config, id);
  if (!normalizeId(checkId)) throw notFound('Check not found');
  const check = readChecks(config, id).find((entry) => entry.id === checkId);
  if (!check) throw notFound('Check not found');

  const limit = integer(query.limit, 1, 500, 100);
  const skip = integer(query.skip, 0, 1_000_000, 0);
  const pages = (check.pages ?? [])
    .filter((page) => !query.status || page.status === query.status)
    .slice(skip, skip + limit);

  return {
    status: 200,
    json: {
      success: true,
      data: {
        ...serializeCheck(check),
        pages,
        totalPages: (check.pages ?? []).length,
        next: skip + limit < (check.pages ?? []).length ? skip + limit : null,
      },
    },
  };
}

export { diffText, compare, summarize };
