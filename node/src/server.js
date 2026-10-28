/**
 * The Web-Kit HTTP API, on Node's own http server so the service installs
 * nothing.
 *
 * The routes and the shapes they return are the ones in openapi.yaml, which is
 * the contract other code is written against. Everything that goes wrong is
 * answered with JSON carrying a code, so a client can tell a refusal from a
 * failure without reading prose.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { search } from './search.js';
import { describeProviders, enabledProviders } from './providers/index.js';
import { fetchDocument, FetchError } from './fetcher.js';
import { UnsafeUrlError } from './safety.js';
import { v2Search, v2Scrape, v2DeveloperSearch } from './compat.js';
import { v2Map } from './map.js';
import { v2CrawlStart, v2CrawlStatus, v2CrawlCancel } from './crawl.js';
import { v2BatchStart, v2BatchStatus, v2BatchCancel } from './batch-scrape.js';
import { v2ExtractStart, v2ExtractStatus, v2ExtractCancel } from './extract.js';
import { v2Parse } from './parse.js';
import { v2DownloadStart, v2DownloadStatus, v2DownloadCancel, v2DownloadFile } from './download.js';
import {
  startScheduler,
  stopScheduler,
  v2MonitorCheck,
  v2MonitorChecks,
  v2MonitorCreate,
  v2MonitorDelete,
  v2MonitorGet,
  v2MonitorList,
  v2MonitorRun,
  v2MonitorUpdate,
} from './monitor.js';

const config = loadConfig();

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendError(response, error) {
  const status = error.status ?? (error.code === 'E_UNSAFE_URL' ? 400 : 502);
  const code = error.code ?? 'E_INTERNAL';
  const known = status < 500;
  sendJson(response, status, {
    error: { code, message: known ? error.message : 'the request could not be completed' },
    request_id: crypto.randomUUID(),
  });
}

/** Constant time comparison, so a wrong token cannot be found one character at a time. */
function authorized(request, expected) {
  if (!expected) return true;
  const header = request.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function readBody(request, config) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        const error = new Error(`request body over ${config.maxBodyBytes} bytes`);
        error.status = 413;
        error.code = 'E_TOO_LARGE';
        request.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        const error = new Error('request body must be valid JSON');
        error.status = 400;
        error.code = 'E_BAD_JSON';
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function bounded(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

const bool = (value) => (value === null || value === undefined ? undefined : value !== 'false');

/**
 * A GET against the compatibility surface, read as if it had been a POST body.
 *
 * The CLI sends POST, but the documented developer endpoint is a GET and a
 * caller may well have bookmarked one. Reading both from one place is cheaper
 * than teaching every handler two shapes.
 */
function paramsAsBody(url, listKeys) {
  const body = {};
  for (const [key, value] of url.searchParams) {
    if (value !== '') body[key] = value;
  }
  // Lists are comma-separated in a query string and arrays in a JSON body.
  for (const key of listKeys) {
    if (typeof body[key] === 'string') {
      body[key] = body[key].split(',').map((entry) => entry.trim()).filter(Boolean);
    }
  }
  if (!body.query && body.q) body.query = body.q;
  return body;
}

const LIST_PARAMS = ['sources', 'includeDomains', 'excludeDomains', 'categories'];

/**
 * The route table for one configuration.
 *
 * A factory rather than a constant because the SDK runs the same engine in a
 * process it owns: the port, the token and the provider ordering come from the
 * caller, not from this module's environment. The deployment still builds it
 * from the environment, so both paths are the same code.
 */
export function makeRoutes(config) {
  return {
  'GET /healthz': async () => ({
    status: 200,
    json: {
      status: 'ok',
      service: 'web-kit',
      version: '0.1.0',
      uptime_s: Math.round(process.uptime()),
      ...(config.instance ? { instance: config.instance } : {}),
    },
  }),

  'GET /readyz': async () => ({
    status: 200,
    json: {
      status: 'ready',
      providers: enabledProviders(config).length,
      auth_required: Boolean(config.apiToken),
      ...(config.instance ? { instance: config.instance } : {}),
      // Whether the general index is available without a key. It is the one
      // setting that changes the quality of an answer, so it is reported where
      // a deployment check can see it.
      keyless_firecrawl: Boolean(config.keylessFirecrawl) && !config.firecrawlApiKey,
    },
  }),

  'GET /': async () => ({
    status: 200,
    json: {
      service: 'web-kit',
      routes: [
        '/healthz', '/readyz', '/v1/providers', '/v1/search', '/v1/fetch',
        '/v2/search', '/v2/scrape', '/v2/map', '/v2/crawl', '/v2/batch/scrape',
        '/v2/extract', '/v2/parse', '/v2/download', '/v2/monitor', '/v2/search/developer',
      ],
      providers: describeProviders(config),
      auth_required: Boolean(config.apiToken),
    },
  }),

  'GET /v1/providers': async () => ({ status: 200, json: describeProviders(config) }),

  'GET /v1/search': async (_query, url, _body) => {
    const query = url.searchParams.get('q') ?? '';
    if (!query.trim()) return { status: 400, json: { error: { code: 'E_BAD_REQUEST', message: 'q is required' } } };
    const result = await search({
      query,
      mode: url.searchParams.get('mode') ?? undefined,
      limit: bounded(url.searchParams.get('limit'), 1, 100, 10),
    }, config);
    return { status: 200, json: result };
  },

  'POST /v1/search': async (_query, _url, body) => {
    if (typeof body.query !== 'string' || !body.query.trim()) {
      return { status: 400, json: { error: { code: 'E_BAD_REQUEST', message: 'query is required' } } };
    }
    if (body.query.length > 1000) {
      return { status: 400, json: { error: { code: 'E_BAD_REQUEST', message: 'query over 1000 characters' } } };
    }
    return { status: 200, json: await search(body, config) };
  },

  'GET /v1/fetch': async (_query, url, _body) => {
    const target = url.searchParams.get('url');
    if (!target) return { status: 400, json: { error: { code: 'E_BAD_REQUEST', message: 'url is required' } } };
    return {
      status: 200,
      json: await fetchDocument(target, {
        mode: url.searchParams.get('mode') ?? undefined,
        render: url.searchParams.get('render') ?? undefined,
        timeout_ms: bounded(url.searchParams.get('timeout_ms'), 100, config.timeoutMs, config.timeoutMs),
        max_bytes: bounded(url.searchParams.get('max_bytes'), 1024, config.maxBodyBytes, config.maxBodyBytes),
        follow_redirects: bool(url.searchParams.get('follow_redirects')),
        respect_robots: bool(url.searchParams.get('respect_robots')),
        include_links: bool(url.searchParams.get('include_links')),
        include_images: bool(url.searchParams.get('include_images')),
      }, config),
    };
  },

  'POST /v1/fetch': async (_query, _url, body) => {
    if (typeof body.url !== 'string' || !body.url.trim()) {
      return { status: 400, json: { error: { code: 'E_BAD_REQUEST', message: 'url is required' } } };
    }
    return {
      status: 200,
      json: await fetchDocument(body.url, {
        mode: body.mode,
        render: body.render,
        timeout_ms: bounded(body.timeout_ms, 100, config.timeoutMs, config.timeoutMs),
        maxRedirects: bounded(body.max_redirects, 0, 10, 5),
        max_bytes: bounded(body.max_bytes, 1024, config.maxBodyBytes, config.maxBodyBytes),
        follow_redirects: body.follow_redirects,
        respect_robots: body.respect_robots,
        include_links: body.include_links,
        include_images: body.include_images,
      }, config),
    };
  },

  /**
   * The Firecrawl-compatible surface.
   *
   * One env var on the client side (`FIRECRAWL_API_URL`) is the whole point:
   * the skills are written against `firecrawl <command>`, so answering these
   * routes keeps them working without touching any of them.
   */
  'POST /v2/search': async (_query, _url, body) => ({ status: 200, json: await v2Search(body, config) }),
  'GET /v2/search': async (_query, url) => ({
    status: 200,
    json: await v2Search(paramsAsBody(url, LIST_PARAMS), config),
  }),

  'POST /v2/scrape': async (_query, _url, body) => ({ status: 200, json: await v2Scrape(body, config) }),

  /**
   * `map` is the one route that answers synchronously: it reads a sitemap and a
   * page and returns a list, which is a map. `crawl`, `batch/scrape` and
   * `extract` outlive a comfortable request, so they answer with an id.
   */
  'POST /v2/map': async (_query, _url, body) => ({ status: 200, json: await v2Map(body, config) }),
  'POST /v2/crawl': async (_query, _url, body) => ({ status: 200, json: await v2CrawlStart(body, config) }),
  'POST /v2/batch/scrape': async (_query, _url, body) => ({ status: 200, json: await v2BatchStart(body, config) }),
  'POST /v2/extract': async (_query, _url, body) => ({ status: 200, json: await v2ExtractStart(body, config) }),
  'POST /v2/parse': async (_query, _url, body, req) => ({ status: 200, json: await v2Parse(body, req, config) }),
  'POST /v2/download': async (_query, _url, body) => ({ status: 200, json: await v2DownloadStart(body, config) }),

  // v1 aliases
  'POST /v1/scrape': async (_query, _url, body) => ({ status: 200, json: await v2Scrape(body, config) }),
  'GET /v1/search': async (_query, url) => ({ status: 200, json: await v2Search(paramsAsBody(url, LIST_PARAMS), config) }),
  'POST /v1/search': async (_query, _url, body) => ({ status: 200, json: await v2Search(body, config) }),
  'POST /v1/map': async (_query, _url, body) => ({ status: 200, json: await v2Map(body, config) }),
  'POST /v1/crawl': async (_query, _url, body) => ({ status: 200, json: await v2CrawlStart(body, config) }),
  'POST /v1/batch/scrape': async (_query, _url, body) => ({ status: 200, json: await v2BatchStart(body, config) }),
  'POST /v1/extract': async (_query, _url, body) => ({ status: 200, json: await v2ExtractStart(body, config) }),
  'POST /v1/parse': async (_query, _url, body, req) => ({ status: 200, json: await v2Parse(body, req, config) }),
  'POST /v1/download': async (_query, _url, body) => ({ status: 200, json: await v2DownloadStart(body, config) }),

  // Monitors answer their own shapes, so the route is the handler.
  'GET /v2/monitor': async (_query, url) => v2MonitorList(Object.fromEntries(url.searchParams), config),
  'POST /v2/monitor': async (_query, _url, body) => v2MonitorCreate(body, config),

  'GET /v2/search/developer': async (_query, url) => ({
    status: 200,
    json: await v2DeveloperSearch(Object.fromEntries(url.searchParams), config),
  }),
  'POST /v2/search/developer': async (_query, _url, body) => ({
    status: 200,
    json: await v2DeveloperSearch(body, config),
  }),
  };
}

/**
 * Routes with an id in the path.
 *
 * The exact-key table cannot express `/v2/crawl/:id`, and a pattern array is
 * both smaller and clearer than teaching the table about segments. The id
 * pattern is the same one the job store accepts, so a path that cannot name a
 * job is a 404 rather than a lookup that fails later.
 */
const JOB_ID = '([A-Za-z0-9_-]{1,120})';

const DYNAMIC_ROUTES = [
  { method: 'GET', pattern: new RegExp(`^/v2/crawl/${JOB_ID}$`), handler: (m, _q, _b, c) => v2CrawlStatus(m[1], c) },
  { method: 'DELETE', pattern: new RegExp(`^/v2/crawl/${JOB_ID}$`), handler: (m, _q, _b, c) => v2CrawlCancel(m[1], c) },
  { method: 'GET', pattern: new RegExp(`^/v1/crawl/${JOB_ID}$`), handler: (m, _q, _b, c) => v2CrawlStatus(m[1], c) },
  { method: 'DELETE', pattern: new RegExp(`^/v1/crawl/${JOB_ID}$`), handler: (m, _q, _b, c) => v2CrawlCancel(m[1], c) },

  { method: 'GET', pattern: new RegExp(`^/v2/batch/scrape/${JOB_ID}$`), handler: (m, _q, _b, c) => v2BatchStatus(m[1], c) },
  { method: 'DELETE', pattern: new RegExp(`^/v2/batch/scrape/${JOB_ID}$`), handler: (m, _q, _b, c) => v2BatchCancel(m[1], c) },
  { method: 'GET', pattern: new RegExp(`^/v1/batch/scrape/${JOB_ID}$`), handler: (m, _q, _b, c) => v2BatchStatus(m[1], c) },
  { method: 'DELETE', pattern: new RegExp(`^/v1/batch/scrape/${JOB_ID}$`), handler: (m, _q, _b, c) => v2BatchCancel(m[1], c) },

  { method: 'GET', pattern: new RegExp(`^/v2/extract/${JOB_ID}$`), handler: (m, _q, _b, c) => v2ExtractStatus(m[1], c) },
  { method: 'DELETE', pattern: new RegExp(`^/v2/extract/${JOB_ID}$`), handler: (m, _q, _b, c) => v2ExtractCancel(m[1], c) },
  { method: 'GET', pattern: new RegExp(`^/v1/extract/${JOB_ID}$`), handler: (m, _q, _b, c) => v2ExtractStatus(m[1], c) },
  { method: 'DELETE', pattern: new RegExp(`^/v1/extract/${JOB_ID}$`), handler: (m, _q, _b, c) => v2ExtractCancel(m[1], c) },
  { method: 'GET', pattern: new RegExp(`^/v2/download/${JOB_ID}$`), handler: (m, _q, _b, c) => v2DownloadStatus(m[1], c) },
  { method: 'DELETE', pattern: new RegExp(`^/v2/download/${JOB_ID}$`), handler: (m, _q, _b, c) => v2DownloadCancel(m[1], c) },
  { method: 'GET', pattern: new RegExp(`^/v2/download/${JOB_ID}/file$`), handler: (m, _q, _b, c) => v2DownloadFile(m[1], c) },
  { method: 'GET', pattern: new RegExp(`^/v1/download/${JOB_ID}$`), handler: (m, _q, _b, c) => v2DownloadStatus(m[1], c) },
  { method: 'DELETE', pattern: new RegExp(`^/v1/download/${JOB_ID}$`), handler: (m, _q, _b, c) => v2DownloadCancel(m[1], c) },
  { method: 'GET', pattern: new RegExp(`^/v1/download/${JOB_ID}/file$`), handler: (m, _q, _b, c) => v2DownloadFile(m[1], c) },

  { method: 'GET', pattern: new RegExp(`^/v2/monitor/${JOB_ID}$`), handler: (m, _q, _b, c) => v2MonitorGet(m[1], c) },
  { method: 'PATCH', pattern: new RegExp(`^/v2/monitor/${JOB_ID}$`), handler: (m, _q, b, c) => v2MonitorUpdate(m[1], b, c) },
  { method: 'PUT', pattern: new RegExp(`^/v2/monitor/${JOB_ID}$`), handler: (m, _q, b, c) => v2MonitorUpdate(m[1], b, c) },
  { method: 'DELETE', pattern: new RegExp(`^/v2/monitor/${JOB_ID}$`), handler: (m, _q, _b, c) => v2MonitorDelete(m[1], c) },
  { method: 'POST', pattern: new RegExp(`^/v2/monitor/${JOB_ID}/run$`), handler: (m, _q, _b, c) => v2MonitorRun(m[1], c) },
  { method: 'GET', pattern: new RegExp(`^/v2/monitor/${JOB_ID}/checks$`), handler: (m, q, _b, c) => v2MonitorChecks(m[1], q, c) },
  {
    method: 'GET',
    pattern: new RegExp(`^/v2/monitor/${JOB_ID}/checks/${JOB_ID}$`),
    handler: (m, q, _b, c) => v2MonitorCheck(m[1], m[2], q, c),
  },
];

function matchDynamic(method, pathname) {
  for (const route of DYNAMIC_ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match) return { route, match };
  }
  return null;
}

export function createServer(configOverride) {
  // The SDK passes its own configuration; a deployed instance reads the
  // environment once at load, as before.
  const active = configOverride ?? config;

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const isOpen = url.pathname === '/healthz' || url.pathname === '/readyz' || url.pathname === '/';
    // Firecrawl's clients read `success` and `error` at the top level. Answering
    // one of its endpoints with our own error envelope would turn a clear
    // refusal into "unexpected response", so the shape follows the surface the
    // caller thinks it is talking to.
    const isCompat = url.pathname.startsWith('/v2/');
    const routes = makeRoutes(active);

    if (!isOpen && !authorized(request, active.apiToken)) {
      if (isCompat) return sendJson(response, 401, { success: false, error: 'a bearer token is required' });
      return sendJson(response, 401, {
        error: { code: 'E_UNAUTHORIZED', message: 'a bearer token is required' },
        request_id: crypto.randomUUID(),
      });
    }

    const route = routes[`${request.method} ${url.pathname}`];
    const dynamic = route ? null : matchDynamic(request.method, url.pathname);
    if (!route && !dynamic) {
      if (isCompat) {
        return sendJson(response, 404, { success: false, error: `no route for ${request.method} ${url.pathname}` });
      }
      return sendJson(response, 404, {
        error: { code: 'E_NOT_FOUND', message: `no route for ${request.method} ${url.pathname}` },
      });
    }

    try {
      const query = Object.fromEntries(url.searchParams);
      const body = request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH'
        ? await readBody(request, active)
        : {};
      const result = dynamic
        ? await dynamic.route.handler(dynamic.match, query, body, active)
        : await route(query, url, body);
      // Some handlers return a raw body (e.g. file downloads) instead of JSON.
      if (result.body !== undefined) {
        response.writeHead(result.status, {
          'content-type': result.headers?.['content-type'] ?? 'application/octet-stream',
          ...result.headers,
        });
        response.end(Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body));
        return;
      }
      return sendJson(response, result.status, result.json);
    } catch (error) {
      if (isCompat) {
        const status = error.status ?? 502;
        return sendJson(response, status, {
          success: false,
          error: status < 500 ? error.message : `the request could not be completed: ${error.message}`,
        });
      }
      return sendError(response, error);
    }
  });
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectExecution) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`web-kit listening on ${config.bindAddr}; instances: ${config.searxngUrls.join(', ')}`);
    console.log(`auth: ${config.apiToken ? 'required' : 'open'}`);
    // Monitors are a standing promise: a created monitor is expected to run
    // without anyone polling it, so the clock starts with the listener.
    if (startScheduler(config)) console.log(`monitors: scheduling under ${config.dataDir}`);
  });
  const shutdown = () => {
    stopScheduler();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export { config };
