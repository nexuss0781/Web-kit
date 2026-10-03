/**
 * The Firecrawl client, and the only place that knows Firecrawl exists.
 *
 * Firecrawl is the one dependency in this service that answers questions the
 * free providers cannot. The other six are vertical indexes -- encyclopaedia,
 * news, papers, code, books -- and between them they have no opinion about a
 * product, a company, an error message, or anything posted this morning.
 * Firecrawl is a general index, so it is what makes `web.search` a search rather
 * than a lookup.
 *
 * It is also the only way this service can read a page that needs a browser.
 * `render: auto|always` hands the URL here and gets back the page as a browser
 * would have seen it, which is the difference between a React app's shell and
 * its actual content.
 *
 * Both calls are POSTs, so the GET-only helper in http.js cannot serve them and
 * this module carries its own small one. It stays dependency free like the rest
 * of the service: Firecrawl publishes an SDK and an MCP server, and neither is
 * needed to make two HTTP requests.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { DEFAULT_TIMEOUT_MS, USER_AGENT } from './http.js';

const API_HOST = 'api.firecrawl.dev';

/** A rendered page is worth more than this much of itself. */
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

/** Same family rule as http.js: prefer IPv4, because AAAA often has no route. */
const families = new Map();

async function familyFor(hostname) {
  const cached = families.get(hostname);
  if (cached) return cached;
  const pending = lookup(hostname, { all: true }).then((answers) => {
    if (answers.length === 0) throw new Error(`could not resolve ${hostname}`);
    return (answers.find((answer) => answer.family === 4) ?? answers[0]).family;
  });
  families.set(hostname, pending);
  pending.catch(() => families.delete(hostname));
  return pending;
}

/** POSTs JSON and requires a 2xx back, the way getJson does for GET. */
export async function postJson(target, body, { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} }) {
  const parsed = new URL(target);
  const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  const family = await familyFor(parsed.hostname);
  const payload = Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    // One place where a success becomes a value and a failure becomes a throw.
    const settle = (build) => {
      let value;
      try {
        value = build();
      } catch (error) {
        reject(error);
        return;
      }
      resolve(value);
    };

    const req = send(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        family,
        // Firecrawl certifies the name, so the name stays the name.
        servername: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': payload.length,
          authorization: `Bearer ${apiKey}`,
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            req.destroy(new Error(`response from ${parsed.hostname} exceeds ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          // Every exit from here goes through settle(), never a throw: this runs
          // in a socket callback, where a thrown error would escape the promise
          // entirely and leave the caller waiting on a promise nobody will ever
          // resolve.
          settle(() => {
            // The status is the more fundamental signal, so it is checked first
            // and reported even when the error body is not JSON -- "402" says
            // more than "did not answer with JSON" ever could.
            if (res.statusCode < 200 || res.statusCode >= 300) {
              let detail = text.slice(0, 200);
              try {
                const parsed = JSON.parse(text);
                if (parsed?.error) detail = String(parsed.error);
              } catch { /* the body was not JSON; the status still says enough */ }
              throw new Error(`firecrawl ${res.statusCode}: ${detail}`);
            }
            let body;
            try { body = JSON.parse(text); } catch { throw new Error(`${parsed.hostname} did not answer with JSON`); }
            // Firecrawl answers 200 with success:false for a refused request, so
            // the status alone does not say whether this worked.
            if (body.success === false) {
              const detail = body.error ?? JSON.stringify(body.details ?? '').slice(0, 200);
              throw new Error(`firecrawl refused the request: ${detail}`);
            }
            return body;
          });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer from firecrawl within ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/** Our time_range vocabulary onto Firecrawl's `tbs` codes, which are Google's. */
const TBS = new Map([
  ['day', 'qdr:d'], ['week', 'qdr:w'], ['month', 'qdr:m'], ['year', 'qdr:y'],
  ['hour', 'qdr:h'], ['qdr:h', 'qdr:h'], ['qdr:d', 'qdr:d'], ['qdr:w', 'qdr:w'],
  ['qdr:m', 'qdr:m'], ['qdr:y', 'qdr:y'],
]);

/**
 * Firecrawl has no domain parameter but indexes `site:`, which is the same
 * restriction expressed differently. One domain is a plain clause; several
 * become a disjunction, so asking for two widens the search rather than
 * narrowing it to a page that cannot exist.
 */
export function withDomains(query, domains) {
  const usable = (Array.isArray(domains) ? domains : [])
    .map((domain) => String(domain ?? '').trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, ''))
    .filter(Boolean);
  if (usable.length === 0) return String(query ?? '').trim();
  return `${String(query ?? '').trim()} (${usable.map((domain) => `site:${domain}`).join(' OR ')})`.trim();
}

/**
 * Asks Firecrawl who is talking about this. No hydration: results come back as
 * title, url and description and nothing else, because fetching ten pages to
 * summarise ten pages is ten times the cost for a snippet nobody asked to read.
 * The caller fetches the one or two results it actually wants.
 */
export async function search(query, request = {}, config = {}) {
  const timeRange = String(request.time_range ?? '').trim().toLowerCase();
  // Tested against 0 and negatives rather than `|| 10`, because `Number(0) || 10`
  // is 10: a caller asking for no results at all would be handed ten.
  const asked = Number(request.limit);
  const limit = Math.min(Math.max(Number.isFinite(asked) ? Math.trunc(asked) : 10, 1), 50);
  const response = await postJson(`${config.firecrawlApiUrl || `https://${API_HOST}`}/v1/search`, {
    query: withDomains(query, request.domains),
    limit,
    ...(TBS.get(timeRange) ? { tbs: TBS.get(timeRange) } : {}),
    // A bad url in the index should not fail the whole search.
    ignoreInvalidURLs: true,
  }, { apiKey: config.firecrawlApiKey, timeoutMs: config.searchTimeoutMs });

  return Array.isArray(response.data) ? response.data : [];
}

/**
 * Fetches one page the way a browser would see it, and returns it as Markdown.
 * This is what `render: auto|always` calls; nothing else here uses it.
 */
export async function scrape(url, options = {}, config = {}) {
  const { timeoutMs, maxAge, waitFor } = options;
  const body = {
    url,
    formats: ['markdown'],
    // Navigation and footers are noise on a page whose content we want.
    onlyMainContent: true,
    waitFor: waitFor ?? 1500,
  };
  // maxAge is what lets Firecrawl reuse a recent copy instead of re-rendering.
  // 0 means "do not reuse", which is the right answer only when the page is
  // changing faster than the caller can act on it.
  if (maxAge !== undefined) body.maxAge = maxAge;

  const response = await postJson(`${config.firecrawlApiUrl || `https://${API_HOST}`}/v1/scrape`, body, {
    apiKey: config.firecrawlApiKey,
    timeoutMs,
  });
  return response.data ?? {};
}