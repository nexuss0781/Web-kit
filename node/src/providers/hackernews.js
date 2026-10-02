/**
 * Hacker News, through the Algolia search API that backs hnsearch. Free, no
 * key, and it answers in well under a second.
 */

import { getJson, url } from '../http.js';

async function search(request, config) {
  const startedAt = Date.now();
  const data = await getJson(url('https://hn.algolia.com/api/v1/search', {
    query: request.query,
    hitsPerPage: Math.min(request.limit ?? 10, 30),
    // Comments are noise for a search result; asking for stories keeps every hit
    // pointed at something worth fetching.
    tags: 'story',
  }), { timeoutMs: config.searchTimeoutMs });

  return {
    latency: Date.now() - startedAt,
    rows: (data.hits ?? []).map((hit) => ({
      title: String(hit.title ?? hit.story_title ?? '').trim(),
      // A comment hit has no external url; the discussion is the best we have.
      url: String(hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`),
      snippet: String(hit.story_text ?? '').replace(/<[^>]*>/g, '').trim().slice(0, 400),
    })).filter((row) => row.url && row.title),
  };
}

export default {
  id: 'hackernews',
  label: 'Hacker News',
  capabilities: ['search'],
  search,
};
