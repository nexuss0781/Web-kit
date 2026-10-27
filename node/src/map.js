/**
 * POST|GET /v2/map
 *
 * Link discovery for one site. This is not a crawl and deliberately so: a map
 * is a question about a site's shape, and the two places a site publishes that
 * shape are its sitemaps and the links on the page the caller named. Answering
 * from those keeps a map to a handful of requests instead of one per page.
 *
 * The response is Firecrawl's: `{success, id, links:[{url}], warning?}`. Titles
 * and descriptions are part of that shape but a sitemap does not carry them, so
 * they are omitted rather than invented.
 */

import crypto from 'node:crypto';
import { fetchDocument } from './fetcher.js';
import { parseUrl, assertPublicHost } from './safety.js';
import {
  linksInHtml,
  normalizeUrl,
  pathWithin,
  sameSite,
  sitemapUrls,
} from './discovery.js';

/** Parse an integer and hold it between two bounds, falling back when absent. */
function clamp(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

const MIN_MAP_LIMIT = 1;
const MAX_MAP_LIMIT = 100_000;
const DEFAULT_MAP_LIMIT = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: 'E_BAD_REQUEST' });
}

export async function v2Map(body = {}, config = {}) {
  const seed = String(body.url ?? '').trim();
  if (!seed) throw badRequest('url is required');

  // Checked before anything touches the network, as every caller-named URL is.
  const parsed = parseUrl(seed);
  await assertPublicHost(parsed);

  const limit = clamp(body.limit, MIN_MAP_LIMIT, MAX_MAP_LIMIT, DEFAULT_MAP_LIMIT);
  const sitemapMode = ['include', 'skip', 'only'].includes(body.sitemap) ? body.sitemap : 'include';
  const includeSubdomains = body.includeSubdomains !== false;
  const ignoreQueryParameters = body.ignoreQueryParameters !== false;
  const filterByPath = body.filterByPath !== false;
  const search = typeof body.search === 'string' ? body.search.trim() : '';
  const timeoutMs = clamp(body.timeout, 1_000, 60_000, DEFAULT_TIMEOUT_MS);
  const agent = config.userAgent || 'Web-Kit/0.1';

  const warnings = [];
  const seen = new Set();
  const links = [];

  const admit = (raw) => {
    if (links.length >= limit) return;
    const url = normalizeUrl(raw, ignoreQueryParameters);
    if (!url || seen.has(url)) return;
    if (!sameSite(url, seed, includeSubdomains)) return;
    if (filterByPath && !pathWithin(url, seed)) return;
    seen.add(url);
    links.push({ url });
  };

  // The page the caller named is a URL on the site, sitemap or no sitemap.
  admit(parsed.href);

  if (sitemapMode !== 'skip') {
    try {
      const discovered = await sitemapUrls(parsed.href, {
        agent,
        timeoutMs,
        maxPages: limit,
        config,
        onWarning: (line) => warnings.push(line),
      });
      for (const url of discovered) {
        if (links.length >= limit) break;
        admit(url);
      }
    } catch (error) {
      warnings.push(`sitemap: ${error.message}`);
    }
  }

  if (sitemapMode !== 'only' && links.length < limit) {
    try {
      const result = await fetchDocument(parsed.href, {
        mode: 'raw',
        timeout_ms: timeoutMs,
        max_bytes: config.maxBodyBytes,
        follow_redirects: true,
        respect_robots: true,
        include_links: false,
        include_images: false,
      }, config);
      const html = result.document.raw ?? '';
      for (const url of linksInHtml(html, result.retrieval.final_url)) {
        if (links.length >= limit) break;
        admit(url);
      }
      if (result.retrieval.truncated) warnings.push('the seed page was truncated before every link was read');
    } catch (error) {
      // A sitemap answer still stands when the seed page itself is unreadable.
      if (links.length <= 1) throw error;
      warnings.push(`the seed page could not be read (${error.message}); answering from the sitemap`);
    }
  }

  let final = links;
  if (search) {
    // The upstream filter is an embedding similarity. This is a plain term
    // filter, which is the honest version of it without a model: every term
    // must appear in the URL, and no match means no match rather than "here is
    // everything instead".
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    final = links.filter((entry) => {
      const haystack = entry.url.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    if (final.length === 0) warnings.push(`no URL matched "${search}"`);
  }

  if (links.length >= limit) warnings.push(`stopped at the limit of ${limit} URLs`);

  return {
    success: true,
    id: `map_${crypto.randomUUID()}`,
    links: final,
    ...(warnings.length ? { warning: warnings.join('; ') } : {}),
  };
}
