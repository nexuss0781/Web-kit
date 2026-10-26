/**
 * One client, two transports.
 *
 * A long-lived agent points at the daemon and gets a real HTTP endpoint, which
 * is also what the Firecrawl CLI and the skills use. A short script can call the
 * engine in-process, with no daemon, no port and nothing left running. Both
 * return the same envelopes, so a caller does not have to know which one it got.
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

  const call = async (pathname, body) => {
    const response = await fetch(`${info.url}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || json?.success === false) {
      if (process.env.WEBKIT_DEBUG) {
        process.stderr.write(`webkit: ${pathname} -> ${response.status} from ${info.url}: ${JSON.stringify(json)}\n`);
      }
      throw Object.assign(new Error(unauthorizedMessage(response.status, json)), { status: response.status, body: json });
    }
    return json;
  };

  return {
    mode: 'daemon',
    url: info.url,
    search: (body) => call('/v2/search', body),
    scrape: (body) => call('/v2/scrape', body),
    developer: (body) => call('/v2/search/developer', body),
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
