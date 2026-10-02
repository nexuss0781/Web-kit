/**
 * Pulls the parts of a page that describe it rather than show it: the title, the
 * description, the canonical address, and the language.
 *
 * A page states these in several ways and they disagree, so they are gathered in
 * order of how much they are trusted: `<title>` for the title, `og:title` then
 * `twitter:title` as fallbacks; a meta description, falling back to Open Graph;
 * and a `rel=canonical` link, whose absence means the document never said what
 * its own address is.
 */

import { decodeEntities } from './markdown.js';

function metaContent(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const value = decodeEntities(match[1].replace(/\s+/g, ' ').trim());
      if (value) return value;
    }
  }
  return null;
}

function attributes(tag) {
  const map = {};
  for (const match of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    map[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? '';
  }
  return map;
}

export function extractMetadata(html, url) {
  const head = html.slice(0, 400_000);
  // og:title and twitter:title are tried first because they are written for
  // machines and are usually shorter. The <title> element is the fallback and is
  // decoded here rather than through metaContent, which expects a capture group
  // that the element itself does not provide.
  const declaredTitle = metaContent(head, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']*)["']/i,
  ]);
  const titleTag = declaredTitle ? null : head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = declaredTitle
    ?? (titleTag ? decodeEntities(titleTag[1].replace(/\s+/g, ' ').trim()) || null : null);

  const description = metaContent(head, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']*)["']/i,
  ]);

  let canonical = null;
  for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if ((attrs.rel || '').toLowerCase().split(/\s+/).includes('canonical') && attrs.href) {
      try { canonical = new URL(attrs.href, url).href; } catch { canonical = attrs.href; }
      break;
    }
  }

  const languageTag = head.match(/<html\b[^>]*\blang=["']([^"']+)["']/i);
  const typeTag = head.match(/<meta[^>]+http-equiv=["']content-type["'][^>]*content=["'][^"']*charset=([a-z0-9-]+)/i);
  const publishedTag = metaContent(head, [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']*)["']/i,
    /<time[^>]+datetime=["']([^"']*)["']/i,
  ]);

  const links = [];
  const seen = new Set();
  for (const match of head.slice(0, 200_000).matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    let absolute;
    try { absolute = new URL(decodeEntities(match[1]), url).href; } catch { continue; }
    if (absolute.startsWith('http') && !seen.has(absolute)) {
      seen.add(absolute);
      links.push(absolute);
      if (links.length >= 200) break;
    }
  }

  return {
    title: titleText,
    description: description ?? null,
    canonical_url: canonical,
    language: languageTag ? languageTag[1] : null,
    charset: typeTag ? typeTag[1] : null,
    published_at: publishedTag,
    links,
  };
}

/** The host, without a leading www, which is the usual way to name a site. */
export function siteName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Query parameters that identify a campaign or a click, not a page. Two links
 * that differ only in these are the same page, which is what lets a search
 * collapse the same result found three different ways into one entry.
 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
  'gclid', 'gclsrc', 'dclid', 'fbclid', 'msclkid', 'yclid', 'twclid', 'igshid',
  'mc_cid', 'mc_eid', 'mkt_tok', 'ref', 'ref_src', 'ref_url', 'referrer', 'source',
  '_hsenc', '_hsmi', 'vero_id', 'oly_enc_id', 'wt_mc', 'trk', 'spm', 'scm',
]);

/**
 * The address a page should be known by: no scheme case to disagree about, no
 * fragment, no default port, no trailing slash, and none of the campaign
 * parameters above.
 */
export function canonicalUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(name.toLowerCase())) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  // A page reached over http and https is the same page; comparing the https
  // form keeps them from appearing as two results.
  url.protocol = 'https:';
  return url.toString();
}
