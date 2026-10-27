/**
 * The general web index, and the reason this is not just a lookup service.
 *
 * Every other provider here answers a question about one kind of thing. Between
 * them they know encyclopaedias, news, papers, code, and books, which is a real
 * amount of knowledge and is still no use at all for "why is my docker build
 * failing" or "who makes this component". Six providers fanned out will each
 * confidently return nothing for a question none of them was built to answer.
 *
 * This one was built to answer questions, so it is the one that matters for
 * anything general. It is keyed, it is metered, and it is therefore off until
 * FIRECRAWL_API_KEY is set -- a deployment without one behaves exactly as it
 * did before.
 *
 * It deliberately asks for nothing but title, url and description. Hydrating ten
 * results into full page text costs ten times as much and produces a wall of
 * text the caller did not ask to read; /v1/fetch exists to read the one or two
 * results worth reading, and reads them better than a search API would.
 */

import * as firecrawl from '../firecrawl.js';

/** A Firecrawl result into the row shape the rest of the service speaks. */
export function rows(results) {
  return (Array.isArray(results) ? results : []).map((result) => ({
    title: String(result?.title ?? '').replace(/\s+/g, ' ').trim(),
    url: String(result?.url ?? '').trim(),
    // Firecrawl calls this a description but it is not always a short sentence;
    // some results arrive as short Markdown, so it is bounded rather than
    // assumed to be a snippet.
    snippet: String(result?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
  })).filter((row) => row.url);
}

async function search(request, config) {
  if (!config.firecrawlApiKey) throw new Error('firecrawl needs FIRECRAWL_API_KEY');
  const startedAt = Date.now();
  const results = await firecrawl.search(request.query, request, config);
  return { rows: rows(results), latency: Date.now() - startedAt };
}

export default {
  id: 'firecrawl',
  label: 'Firecrawl',
  capabilities: ['search'],
  /** Off unless a key is configured, because there is no anonymous tier. */
  enabledByDefault: (config) => Boolean(config.firecrawlApiKey),
  search,
};