/**
 * One client, two transports.
 *
 * A long-lived agent points at the daemon and gets a real HTTP endpoint, which
 * is also what the Firecrawl CLI and the skills use. A short script can call the
 * engine in-process, with no daemon, no port and nothing left running. Both
 * return the same envelopes, so a caller does not have to know which one it got.
 *
 * Every route the engine answers has a method here. The asynchronous ones are
 * pairs -- start returns an id, status reads it -- because that is the shape the
 * engine has, and hiding it behind an await would mean holding a request open
 * for a crawl that may run for minutes.
 */

import { readSettings, engineEnv } from './settings.js';
import { loadSurface } from './engine.js';
import * as searxng from './searxng.js';
import { isRunning, readDaemon } from './daemon.js';

function unauthorizedMessage(status, body) {
  if (status === 401) return 'the local engine requires a token; set WEBKIT_API_TOKEN or remove it from ~/.webkit/config.json';
  return body?.error ?? body?.message ?? `HTTP ${status}`;
}

function httpClient(info, settings) {
  const headers = { 'content-type': 'application/json' };
  if (settings.token) headers.authorization = `Bearer ${settings.token}`;

  const request = async (method, pathname, body) => {
    const response = await fetch(`${info.url}${pathname}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(300_000),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || json?.success === false) {
      if (process.env.WEBKIT_DEBUG) {
        process.stderr.write(`webkit: ${method} ${pathname} -> ${response.status} from ${info.url}: ${JSON.stringify(json)}\n`);
      }
      throw Object.assign(new Error(unauthorizedMessage(response.status, json)), { status: response.status, body: json });
    }
    return json;
  };
  const post = (pathname, body) => request('POST', pathname, body);
  const get = (pathname) => request('GET', pathname);
  const del = (pathname) => request('DELETE', pathname);

  const id = (value) => encodeURIComponent(String(value));

  return {
    mode: 'daemon',
    url: info.url,
    search: (body) => post('/v2/search', body),
    scrape: (body) => post('/v2/scrape', body),
    developer: (body) => post('/v2/search/developer', body),
    map: (body) => post('/v2/map', body),

    crawl: (body) => post('/v2/crawl', body),
    crawlStatus: (crawlId) => get(`/v2/crawl/${id(crawlId)}`),
    cancelCrawl: (crawlId) => del(`/v2/crawl/${id(crawlId)}`),

    batch: (body) => post('/v2/batch/scrape', body),
    batchStatus: (batchId) => get(`/v2/batch/scrape/${id(batchId)}`),
    cancelBatch: (batchId) => del(`/v2/batch/scrape/${id(batchId)}`),

    extract: (body) => post('/v2/extract', body),
    extractStatus: (extractId) => get(`/v2/extract/${id(extractId)}`),
    cancelExtract: (extractId) => del(`/v2/extract/${id(extractId)}`),

    monitors: () => get('/v2/monitor'),
    createMonitor: (body) => post('/v2/monitor', body),
    getMonitor: (monitorId) => get(`/v2/monitor/${id(monitorId)}`),
    updateMonitor: (monitorId, body) => request('PATCH', `/v2/monitor/${id(monitorId)}`, body),
    deleteMonitor: (monitorId) => del(`/v2/monitor/${id(monitorId)}`),
    runMonitor: (monitorId) => post(`/v2/monitor/${id(monitorId)}/run`, {}),
    monitorChecks: (monitorId) => get(`/v2/monitor/${id(monitorId)}/checks`),
    monitorCheck: (monitorId, checkId) => get(`/v2/monitor/${id(monitorId)}/checks/${id(checkId)}`),
    close: async () => {},
  };
}

async function memoryClient(settings) {
  const surface = await loadSurface();
  const live = settings.searxng ? await searxng.healthy(settings.searxngPort) : false;
  const config = surface.loadConfig(engineEnv({ ...settings, searxng: live }));

  return {
    mode: 'in-process',
    url: null,
    search: (body) => surface.v2Search(body, config),
    scrape: (body) => surface.v2Scrape(body, config),
    developer: (body) => surface.v2DeveloperSearch(body, config),
    map: (body) => surface.v2Map(body, config),

    crawl: (body) => surface.v2CrawlStart(body, config),
    crawlStatus: (crawlId) => surface.v2CrawlStatus(crawlId, config).json,
    cancelCrawl: (crawlId) => surface.v2CrawlCancel(crawlId, config).json,

    batch: (body) => surface.v2BatchStart(body, config),
    batchStatus: (batchId) => surface.v2BatchStatus(batchId, config).json,
    cancelBatch: (batchId) => surface.v2BatchCancel(batchId, config).json,

    extract: (body) => surface.v2ExtractStart(body, config),
    extractStatus: (extractId) => surface.v2ExtractStatus(extractId, config).json,
    cancelExtract: (extractId) => surface.v2ExtractCancel(extractId, config).json,

    monitors: () => surface.v2MonitorList({}, config).json,
    createMonitor: (body) => surface.v2MonitorCreate(body, config).json,
    getMonitor: (monitorId) => surface.v2MonitorGet(monitorId, config).json,
    updateMonitor: (monitorId, body) => surface.v2MonitorUpdate(monitorId, body, config).json,
    deleteMonitor: (monitorId) => surface.v2MonitorDelete(monitorId, config).json,
    runMonitor: (monitorId) => surface.v2MonitorRun(monitorId, config),
    monitorChecks: (monitorId) => surface.v2MonitorChecks(monitorId, {}, config).json,
    monitorCheck: (monitorId, checkId) => surface.v2MonitorCheck(monitorId, checkId, {}, config).json,
    close: async () => {},
  };
}

/**
 * The best client available right now.
 *
 * `inProcess: true` skips the daemon check entirely, which is what a nested
 * agent or a test wants: no shared state, no surprise about who owns the port.
 */
export async function createClient(options = {}) {
  const settings = { ...readSettings(), ...options.settings };

  if (!options.inProcess) {
    const info = readDaemon();
    if (info && await isRunning(info)) return httpClient(info, settings);
  }

  return memoryClient(settings);
}

/** Convenience for a one-shot search. */
export async function search(query, options = {}) {
  const client = await createClient(options);
  try {
    return await client.search({ query, ...options.body });
  } finally {
    await client.close();
  }
}

/** Convenience for a one-shot read of a page. */
export async function scrape(url, options = {}) {
  const client = await createClient(options);
  try {
    return await client.scrape({ url, ...options.body });
  } finally {
    await client.close();
  }
}
