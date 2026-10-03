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
import { pinnedGet, header } from './pinned.js';
import { permitted } from './robots.js';
import { extractMetadata, siteName } from './html.js';
import { htmlToMarkdown, htmlToText } from './markdown.js';
import * as firecrawl from './firecrawl.js';

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

/**
 * Whether a page looks like a shell that only becomes content once a browser
 * runs the scripts in it.
 *
 * The tell is not the markup but the ratio: a React or Vue page ships a small
 * body and a large bundle reference, and all the text arrives later. So a lot
 * of HTML that yields almost no text is a page this service read too early, and
 * a little HTML that yields a good deal of text is a page it read fine.
 */
/**
 * Holds text to a byte ceiling without cutting a character in half.
 *
 * The naive version of this slices the string at `max_bytes` characters, which
 * overruns on anything outside ASCII, or slices the buffer and leaves a lone
 * surrogate or a replacement character at the end. Since the point of the
 * ceiling is that the response is valid and bounded, the cut lands on a
 * character boundary: a buffer slice, then one character dropped if the boundary
 * fell inside one.
 */
export function boundText(text, maxBytes) {
  const fullBytes = Buffer.byteLength(text, 'utf8');
  if (fullBytes <= maxBytes) return { text, bytes: fullBytes, fullBytes, truncated: false };

  let kept = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  // The byte slice can split a multi-byte character, which decodes to U+FFFD.
  // If that landed at the very end it was ours, so it goes; one elsewhere was
  // already in the text and is not ours to remove.
  if (kept.endsWith('�')) kept = kept.slice(0, -1);
  return { text: kept, bytes: Buffer.byteLength(kept, 'utf8'), fullBytes, truncated: true };
}

export function looksUnrendered(html, extractedChars) {
  if (extractedChars >= 500) return false;
  // A small page with little text is a small page, not a shell to be rendered.
  if (html.length < 20_000) return false;
  return html.length / Math.max(extractedChars, 1) > 40;
}

/**
 * Hands a URL to Firecrawl and maps the rendered page back onto this service's
 * document shape, so a caller cannot tell from the response whether the text was
 * read here or in a browser.
 */
async function renderWithFirecrawl(href, options, config, warnings, agent) {
  const startedAt = Date.now();
  const data = await firecrawl.scrape(href, {
    timeoutMs: options.timeout_ms,
    maxAge: config.firecrawlMaxAge,
  }, config);

  // Firecrawl answers with its own status for the page it fetched. Reporting 200
  // regardless would turn a 404 or a paywall into a successful read, so the
  // upstream status is carried through and only absent upstream becomes 200.
  const upstreamStatus = Number(data.metadata?.statusCode ?? data.statusCode ?? 0);
  const status = Number.isFinite(upstreamStatus) && upstreamStatus > 0 ? upstreamStatus : 200;

  let markdown = typeof data.markdown === 'string' ? data.markdown : '';
  const meta = data.metadata ?? {};
  if (!markdown) warnings.push('the renderer returned no content for this page');

  // A rendered article is usually longer than the page as sent, so the ceiling
  // has to be applied to this path too.
  const cut = boundText(markdown, options.max_bytes);
  if (cut.truncated) {
    markdown = cut.text;
    warnings.push(`stopped after ${options.max_bytes} bytes; the page continues past that`);
  }
  const fullBytes = cut.fullBytes;

  const document = {
    content_hash: markdown ? `sha256:${crypto.createHash('sha256').update(markdown).digest('hex')}` : null,
    metadata: {
      title: meta.title ?? null,
      description: meta.description ?? null,
      canonical_url: meta.url ?? meta.sourceURL ?? meta['og:url'] ?? href,
      language: meta.language ?? meta['og:locale'] ?? null,
      charset: null,
      published_at: meta['article:published_time'] ?? meta.publishedTime ?? null,
      site: siteName(meta.url ?? meta.sourceURL ?? href),
      links: [],
    },
    text: null,
    markdown: options.mode === 'markdown' || options.mode === 'raw' ? markdown : null,
    raw: null,
  };
  if (options.mode === 'text') document.text = markdown;
  if (options.mode === 'raw') document.raw = markdown;

  const bytes = Buffer.byteLength(markdown, 'utf8');

  return {
    request_id: crypto.randomUUID(),
    retrieval: {
      requested_url: href,
      final_url: meta.url ?? meta.sourceURL ?? href,
      status,
      content_type: status === 200 ? 'text/markdown; rendered' : `text/markdown; rendered (upstream ${status})`,
      // The size actually returned, and whether the full page was longer. The
      // direct path reports the bytes it read; this reports what survives the
      // ceiling, so the two agree on what `bytes` means.
      bytes,
      truncated: fullBytes > bytes,
      redirects: [],
    },
    document,
    warnings,
    timing: { duration_ms: Date.now() - startedAt, redirects: 0 },
  };
}

export async function fetchDocument(rawUrl, userOptions = {}, config = {}) {
  const options = resolveOptions(userOptions);
  const agent = config.userAgent || 'Web-Kit/0.1 (+https://github.com/nexuss0781/Web-kit)';
  const warnings = [];
  const startedAt = Date.now();
  const deadline = startedAt + options.timeout_ms;

  const first = parseUrl(rawUrl);
  // Checked here so the refusal is immediate and specific, and because the
  // render path hands this URL to another service: a renderer we have not
  // checked is a way to reach a host this service would have refused.
  //
  // This is not the only check, and on its own it would not be enough. The
  // fetch below resolves the name again and dials a verified address, so the
  // answer here and the connection made there cannot come from different DNS
  // lookups. A name that answers public once and private next time wins nothing.
  await assertPublicHost(first);

  if (options.respect_robots) {
    const allowed = await permitted(first.href, agent, options.timeout_ms);
    if (!allowed) {
      throw new FetchError(`robots.txt does not permit ${first.pathname}`, 403, 'E_ROBOTS');
    }
  }

  // A renderer is a second opinion on a URL we have already agreed to fetch.
  // The checks above happen first on purpose: the renderer runs this service's
  // requests from this service's instructions, so it is never asked to visit a
  // host or a scheme the local path would have refused.
  const canRender = Boolean(config.firecrawlApiKey);
  if (options.render === 'always') {
    if (!canRender) {
      warnings.push('render was requested but FIRECRAWL_API_KEY is not set; the page is returned as the server sent it');
    } else {
      return renderWithFirecrawl(first.href, options, config, warnings, agent);
    }
  }

  let current = first;
  const redirectChain = [];
  let response = null;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FetchError(`timed out after ${options.timeout_ms}ms`, 504, 'E_TIMEOUT');

    /**
     * Dialled at an address this service has already resolved and checked.
     *
     * The address comes from the same lookup that passed the safety check, so a
     * name that answers public once and private the next time has nothing to
     * win: there is no second lookup to influence. The name still travels in
     * Host and in TLS SNI, so the site sees the request it expects and the
     * certificate is still checked against the host that was asked for.
     */
    response = await pinnedGet(current, {
      timeoutMs: remaining,
      maxBytes: options.max_bytes,
      headers: {
        'user-agent': agent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-language': 'en;q=0.9',
      },
    });

    const location = header(response, 'location');
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

    // The connection was opened with `connection: close`, so the socket is
    // already closing; nothing is left to drain and nothing is left to release.
    redirectChain.push(current.href);
    current = next;
  }

  const contentType = header(response, 'content-type') ?? '';
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
        bytes: Number(header(response, 'content-length') ?? response.body?.length ?? 0),
        truncated: response.truncated,
        redirects: redirectChain,
      },
      document: { content_hash: null, text: null, markdown: null, metadata: null, links: [] },
      warnings,
      timing: { duration_ms: Date.now() - startedAt, redirects: redirectChain.length },
    };
  }

  const bytes = response.body?.length ?? 0;
  if (response.truncated) warnings.push(`stopped after ${options.max_bytes} bytes; the page continues past that`);
  if (response.status >= 400) warnings.push(`the page answered ${response.status}`);

  const html = decodeWithCharset(response.body ?? Buffer.alloc(0), charset);
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

  // `auto` means the caller does not know whether this page needs a browser, so
  // the local read is tried first and the renderer is only paid for when the
  // page turns out to have been a shell. That keeps a rendered page the exception
  // rather than a tax on every fetch, and a page that is merely short is never
  // mistaken for one.
  if (options.render === 'auto' && canRender) {
    const textish = document.markdown ?? document.text ?? '';
    if (looksUnrendered(html, textish.length)) {
      try {
        const rendered = await renderWithFirecrawl(first.href, options, config, warnings, agent);
        rendered.warnings.unshift('the page arrived as a script shell and was re-read in a browser');
        return rendered;
      } catch (error) {
        // The local read already succeeded, so a renderer failure is a note and
        // not an error: the caller gets what we have rather than nothing.
        warnings.push(`the page needed rendering and the renderer failed (${error.message}); returning what the server sent`);
      }
    }
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
      truncated: response.truncated,
      redirects: redirectChain,
    },
    document,
    warnings,
    timing: { duration_ms: Date.now() - startedAt, redirects: redirectChain.length },
  };
}
