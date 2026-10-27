/**
 * Finding URLs: the part `map` and `crawl` share.
 *
 * Nothing here scrapes a page for its content. The job is to answer "what else
 * is on this site" from the two places a site says so -- its sitemaps and the
 * links on a page -- and to apply the scope rules once, so `map` and `crawl`
 * cannot disagree about what belongs to the site.
 */

import { gunzipSync } from 'node:zlib';
import { pinnedGet, header } from './pinned.js';
import { parseUrl } from './safety.js';

/** A sitemap tree can be deep; this is the request budget for one map, not a level. */
const MAX_SITEMAPS = 40;
const MAX_SITEMAP_BYTES = 8 * 1024 * 1024;

/** Absolute URL from a possibly-relative href, or null when it is not one. */
export function absoluteUrl(href, baseUrl) {
  try {
    const url = new URL(String(href), baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Page links from HTML.
 *
 * `<a href>` is the obvious one. `<area href>` is an image map, which is a real
 * navigation target on older sites. `<link>` is deliberately not included:
 * canonical, alternate, stylesheet and preload all live there, and treating a
 * stylesheet as a page is how a crawl ends up fetching `site.css`.
 */
export function linksInHtml(html, pageUrl) {
  const found = new Set();
  for (const match of String(html ?? '').matchAll(/<(?:a|area)\b[^>]*href=["']([^"'#\s]+)["']/gi)) {
    const url = absoluteUrl(match[1], pageUrl);
    if (url) found.add(url);
  }
  return [...found];
}

/** The host a site is known by, without `www.` or a path. */
export function baseHost(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return String(value ?? '').trim().toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

export function sameHost(a, b) {
  return baseHost(a) === baseHost(b);
}

/**
 * Whether `candidate` is inside the site being mapped or crawled.
 *
 * `www.` is stripped from both sides because a site that links to itself
 * without it is not linking somewhere else. Subdomains are a separate switch:
 * `docs.example.com` is part of the site only when the caller says so.
 */
export function sameSite(candidate, seed, allowSubdomains = true) {
  const host = baseHost(candidate);
  const site = baseHost(seed);
  if (host === site) return true;
  return Boolean(allowSubdomains) && host.endsWith(`.${site}`);
}

/** Drops the query string, which a caller may ask for on a site with facets. */
export function normalizeUrl(value, ignoreQueryParameters) {
  if (!ignoreQueryParameters) return value;
  try {
    const url = new URL(String(value));
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return value;
  }
}

/** Whether a path is the seed path or below it. A file seed is its own scope. */
export function pathWithin(candidate, seedUrl) {
  try {
    const seed = new URL(seedUrl);
    const target = new URL(candidate);
    const prefix = seed.pathname === '/' ? '' : seed.pathname.replace(/\/$/, '');
    if (!prefix) return true;
    return target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
  } catch {
    return false;
  }
}

function escapeRegExp(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A crawler path pattern.
 *
 * Firecrawl's paths are prefix patterns in practice -- `--include-paths /docs`
 * is expected to cover `/docs/install` -- so a pattern without `*` matches the
 * path and everything under it. A pattern with `*` is a glob, and a trailing
 * `$` asks for the exact path.
 */
export function pathMatches(pattern, pathname) {
  const exact = String(pattern).endsWith('$');
  const body = exact ? String(pattern).slice(0, -1) : String(pattern);
  if (!body.includes('*')) {
    if (exact) return pathname === body;
    const prefix = body.replace(/\/$/, '');
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  }
  const source = body.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}${exact ? '$' : ''}`).test(pathname);
}

/**
 * The include/exclude decision, applied to the path or -- when the caller asked
 * for `regexOnFullURL` -- to the whole address. `pathMatches` treats a pattern
 * without `*` as a prefix, which is the right reading of both forms.
 */
export function pathAllowed(value, includePaths = [], excludePaths = [], { fullUrl = false } = {}) {
  let subject;
  try {
    const url = new URL(String(value));
    subject = fullUrl ? url.href : url.pathname;
  } catch {
    return false;
  }
  if (includePaths.length && !includePaths.some((pattern) => pathMatches(pattern, subject))) return false;
  if (excludePaths.some((pattern) => pathMatches(pattern, subject))) return false;
  return true;
}

function decodeSitemap(response) {
  const body = response.body ?? Buffer.alloc(0);
  // Sitemaps are served as text/xml, but `.xml.gz` is common enough that a
  // gzip body showing up under an XML content type is not a surprise.
  if (body[0] === 0x1f && body[1] === 0x8b) {
    try {
      return gunzipSync(body).toString('utf8');
    } catch {
      return '';
    }
  }
  return body.toString('utf8');
}

function locs(xml) {
  const found = [];
  for (const match of String(xml).matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)) {
    found.push(match[1].trim());
  }
  return found;
}

/** Sitemap directives from robots.txt. */
export async function robotsSitemaps(origin, { agent, timeoutMs = 10_000, config = {} } = {}) {
  try {
    let url = parseUrl(`${origin}/robots.txt`);
    for (let hop = 0; hop <= 3; hop += 1) {
      const response = await pinnedGet(url, {
        timeoutMs: Math.min(timeoutMs, 5000),
        maxBytes: 500_000,
        ...(config.resolve ? { resolve: config.resolve } : {}),
        headers: { 'user-agent': agent, accept: 'text/plain' },
      });
      const location = header(response, 'location');
      if (!location || response.status < 300 || response.status >= 400) {
        if (response.status < 200 || response.status >= 300) return [];
        const text = (response.body ?? Buffer.alloc(0)).toString('utf8');
        const found = [];
        for (const line of text.split(/\r?\n/)) {
          const match = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
          if (match) found.push(match[1]);
        }
        return found;
      }
      url = parseUrl(new URL(location, url).href);
    }
    return [];
  } catch {
    return [];
  }
}

async function fetchSitemap(url, { agent, timeoutMs, config }) {
  let current = parseUrl(url);
  for (let hop = 0; hop <= 3; hop += 1) {
    const response = await pinnedGet(current, {
      timeoutMs: Math.min(timeoutMs, 30_000),
      maxBytes: MAX_SITEMAP_BYTES,
      ...(config.resolve ? { resolve: config.resolve } : {}),
      headers: {
        'user-agent': agent,
        accept: 'application/xml,text/xml,application/gzip;q=0.5,*/*;q=0.1',
      },
    });
    const location = header(response, 'location');
    if (location && response.status >= 300 && response.status < 400) {
      current = parseUrl(new URL(location, current).href);
      continue;
    }
    if (response.status < 200 || response.status >= 300) return '';
    return decodeSitemap(response);
  }
  return '';
}

/**
 * Every page URL a site's sitemaps name, bounded by `maxPages`.
 *
 * A sitemap index is recursed one level (an index of indexes is refused by the
 * spec but exists anyway); `maxSitemaps` keeps a pathological tree from turning
 * one `/map` call into hundreds of requests.
 */
export async function sitemapUrls(seedUrl, {
  agent = 'Web-Kit/0.1',
  timeoutMs = 15_000,
  maxPages = 10_000,
  extraSitemaps = [],
  config = {},
  onWarning = () => {},
} = {}) {
  const origin = new URL(seedUrl).origin;
  const queue = [...extraSitemaps];
  const fromRobots = await robotsSitemaps(origin, { agent, timeoutMs, config });
  queue.push(...fromRobots);
  // The well-known location is tried when robots named nothing, and again after
  // robots' own list, because a site may publish both and only one may be good.
  queue.push(`${origin}/sitemap.xml`);

  const visited = new Set();
  const pages = [];
  let fetched = 0;

  while (queue.length && pages.length < maxPages && fetched < MAX_SITEMAPS) {
    const next = queue.shift();
    if (!next || visited.has(next)) continue;
    visited.add(next);
    fetched += 1;

    const xml = await fetchSitemap(next, { agent, timeoutMs, config });
    if (!xml) continue;

    const isIndex = /<sitemapindex\b/i.test(xml);
    const found = locs(xml);
    if (isIndex) {
      // The queue is flat, so the guard is the sitemap count rather than a
      // level: an index of indexes is bounded by the same budget.
      for (const child of found) {
        const absolute = absoluteUrl(child, next);
        if (absolute && !visited.has(absolute)) queue.push(absolute);
      }
      continue;
    }
    for (const page of found) {
      if (pages.length >= maxPages) break;
      const absolute = absoluteUrl(page, next);
      if (absolute) pages.push(absolute);
    }
  }

  if (fetched >= MAX_SITEMAPS && (queue.length || pages.length >= maxPages)) {
    onWarning(`stopped after ${MAX_SITEMAPS} sitemaps; the site publishes more`);
  }
  return pages;
}
