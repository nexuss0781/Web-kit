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
function authorized(request) {
  if (!config.apiToken) return true;
  const header = request.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = config.apiToken;
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function readBody(request) {
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

const routes = {
  'GET /healthz': async () => ({
    status: 200,
    json: { status: 'ok', service: 'web-kit', version: '0.1.0', uptime_s: Math.round(process.uptime()) },
  }),

  'GET /readyz': async () => ({
    status: 200,
    json: { status: 'ready', providers: enabledProviders(config).length, auth_required: Boolean(config.apiToken) },
  }),

  'GET /': async () => ({
    status: 200,
    json: {
      service: 'web-kit',
      routes: ['/healthz', '/readyz', '/v1/providers', '/v1/search', '/v1/fetch'],
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
};

export function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const isOpen = url.pathname === '/healthz' || url.pathname === '/readyz' || url.pathname === '/';

    if (!isOpen && !authorized(request)) {
      return sendJson(response, 401, {
        error: { code: 'E_UNAUTHORIZED', message: 'a bearer token is required' },
        request_id: crypto.randomUUID(),
      });
    }

    const route = routes[`${request.method} ${url.pathname}`];
    if (!route) {
      return sendJson(response, 404, {
        error: { code: 'E_NOT_FOUND', message: `no route for ${request.method} ${url.pathname}` },
      });
    }

    try {
      const query = Object.fromEntries(url.searchParams);
      const body = request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH'
        ? await readBody(request)
        : {};
      const result = await route(query, url, body);
      return sendJson(response, result.status, result.json);
    } catch (error) {
      return sendError(response, error);
    }
  });
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectExecution) {
  createServer().listen(config.port, config.host, () => {
    console.log(`web-kit listening on ${config.bindAddr}; instances: ${config.searxngUrls.join(', ')}`);
    console.log(`auth: ${config.apiToken ? 'required' : 'open'}`);
  });
}

export { config, routes };
