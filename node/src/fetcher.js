/**
 * Fetches a page and turns it into something an agent can use.
 *
 * Three limits shape this, all of them there because a fetcher without them is a
 * way to hang, to exhaust memory, or to reach something it should not:
 *
 * - Every hop is checked. Redirects are followed by hand rather than by the
 *   runtime, so a public address cannot bounce the request into private space.
 * - The body is read through a byte budget and the connection is closed the
 *   moment it is spent, so a page that never ends costs a bounded amount.
 * - The whole thing is under a deadline, and the clock covers every hop rather
 *   than restarting for each one.
 */

import crypto from 'node:crypto';
import { parseUrl, assertPublicHost, UnsafeUrlError } from './safety.js';
import { permitted } from './robots.js';
import { extractMetadata, siteName } from './html.js';
import { htmlToMarkdown, htmlToText } from './markdown.js';

/**
 * Option names match openapi.yaml exactly, so there is one vocabulary between
 * the API surface and the code behind it and nothing has to be translated.
 * `maxRedirects` is ours alone -- the contract does not expose a limit.
 */
const DEFAULTS = {
  mode: 'markdown',
  render: 'never',
  timeout_ms: 12_000,
  max_bytes: 5_242_880,
  maxRedirects: 5,
  follow_redirects: true,
  respect_robots: true,
  include_links: true,
  include_images: false,
};

export class FetchError extends Error {
  constructor(message, status = 502, code = 'E_FETCH') {
    super(message);
    this.name = 'FetchError';
    this.status = status;
    this.code = code;
  }
}

/** Reads at most `maxBytes` from a response body, then stops. */
async function readBounded(response, maxBytes) {
  if (!response.body) return { text: '', bytes: 0, truncated: false };

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - bytes));
      bytes = maxBytes;
      truncated = true;
      // Stop the transfer instead of draining the rest of a very large page.
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    bytes += value.length;
  }

  const buffer = Buffer.concat(chunks);
  return { text: buffer.toString('utf8'), bytes, truncated };
}

function decodeWithCharset(buffer, charset) {
  const name = (charset || 'utf-8').toLowerCase().replace(/["']/g, '');
  try {
    return new TextDecoder(name).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

/**
 * Fetches one URL.
 *
 * Returns the retrieval record and the document record separately, so a caller
 * asking for `metadata` alone is not handed a megabyte of Markdown it did not
 * want.
 */
/**
 * Fills in the defaults with what the caller actually named.
 *
 * Filtering undefined matters more than it looks. A route that builds its
 * options from a request hands over every documented key whether or not the
 * request mentioned it, and a plain spread would let those undefined values
 * overwrite the defaults -- so respect_robots and follow_redirects would
 * quietly switch off for every request that did not mention them.
 */
export function resolveOptions(userOptions = {}) {
  const named = Object.fromEntries(Object.entries(userOptions).filter(([, value]) => value !== undefined));
  return { ...DEFAULTS, ...named };
}

export async function fetchDocument(rawUrl, userOptions = {}, config = {}) {
  const options = resolveOptions(userOptions);
  const agent = config.userAgent || 'Web-Kit/0.1 (+https://github.com/nexuss0781/Web-kit)';
  const warnings = [];
  if (options.render === 'auto' || options.render === 'always') {
    warnings.push('render was requested but this service does not run a browser; the raw response is used as the server sent it');
  }
  const startedAt = Date.now();
  const deadline = startedAt + options.timeout_ms;

  const first = parseUrl(rawUrl);
  await assertPublicHost(first);

  if (options.respect_robots) {
    const allowed = await permitted(first.href, agent, options.timeout_ms);
    if (!allowed) {
      throw new FetchError(`robots.txt does not permit ${first.pathname}`, 403, 'E_ROBOTS');
    }
  }

  let current = first;
  const redirectChain = [];
  let response = null;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FetchError(`timed out after ${options.timeout_ms}ms`, 504, 'E_TIMEOUT');

    response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(remaining),
      headers: {
        'user-agent': agent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-language': 'en;q=0.9',
      },
    });

    const location = response.headers.get('location');
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect || !options.follow_redirects) break;

    const hops = redirectChain.length;
    if (hops >= options.maxRedirects) {
      warnings.push(`stopped after ${options.maxRedirects} redirects`);
      break;
    }

    // The Location header decides where we go next, so it is checked exactly as
    // carefully as the URL we were given.
    let next;
    try {
      next = parseUrl(new URL(location, current).href);
      await assertPublicHost(next);
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        warnings.push(`refused a redirect to ${location}: ${error.message}`);
        break;
      }
      throw error;
    }

    await response.body?.cancel().catch(() => {});
    redirectChain.push(current.href);
    current = next;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
  const isHtml = /text\/html|application\/xhtml/i.test(contentType) || (!contentType && true);

  // A binary body is reported by type and weight, not decoded: turning an image
  // into a string produces mojibake and teaches the caller nothing.
  if (!isHtml && !/text\/|json|xml/i.test(contentType)) {
    warnings.push(`not a text document (${contentType || 'unknown type'}); body not returned`);
    return {
      retrieval: {
        requested_url: first.href,
        final_url: current.href,
        status: response.status,
        content_type: contentType || null,
        bytes: Number(response.headers.get('content-length') ?? 0),
        truncated: false,
        redirects: redirectChain,
      },
      document: { content_hash: null, text: null, markdown: null, metadata: null, links: [] },
      warnings,
      timing: { duration_ms: Date.now() - startedAt, redirects: redirectChain.length },
    };
  }

  const { text, bytes, truncated } = await readBounded(response, options.max_bytes);
  if (truncated) warnings.push(`stopped after ${options.max_bytes} bytes; the page continues past that`);
  if (response.status >= 400) warnings.push(`the page answered ${response.status}`);

  const html = decodeWithCharset(Buffer.from(text, 'utf8'), charset);
  const metadata = isHtml ? extractMetadata(html, current.href) : { title: null, description: null, canonical_url: null, language: null, charset, published_at: null, links: [] };
  metadata.site = siteName(current.href);
  if (!options.include_links) metadata.links = [];

  const contentHash = crypto.createHash('sha256').update(html).digest('hex');

  const document = {
    content_hash: `sha256:${contentHash}`,
    metadata,
    text: null,
    markdown: null,
    raw: null,
  };
  if (options.mode === 'raw') document.raw = html;
  if (options.mode === 'text') document.text = htmlToText(html);
  if (options.mode === 'markdown') document.markdown = htmlToMarkdown(html);
  if (options.mode === 'metadata') { /* metadata only */ }

  if (options.include_images) {
    document.images = [...html.matchAll(/<img\b[^>]*src=["']([^"']+)["']/gi)]
      .slice(0, 100)
      .map((match) => {
        try { return new URL(match[1], current.href).href; } catch { return null; }
      })
      .filter(Boolean);
  }

  return {
    // Every response carries an id, so a search and the fetches that follow it
    // can be tied together in a log.
    request_id: crypto.randomUUID(),
    retrieval: {
      requested_url: first.href,
      final_url: current.href,
      status: response.status,
      content_type: contentType || null,
      bytes,
      truncated,
      redirects: redirectChain,
    },
    document,
    warnings,
    timing: { duration_ms: Date.now() - startedAt, redirects: redirectChain.length },
  };
}
