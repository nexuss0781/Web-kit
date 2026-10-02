/**
 * arXiv, for papers. The only provider here that speaks Atom rather than JSON,
 * so it carries a very small reader rather than a dependency.
 */

import { getText, url } from '../http.js';

const decode = (value) => String(value ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const tag = (entry, name) => {
  const found = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return found ? decode(found[1].trim()) : '';
};

/**
 * arXiv's query language treats quotes, brackets and the words AND/OR as
 * syntax, so a query carrying any of them comes back as a 400 rather than as
 * results. They are dropped and the remaining words are passed on unquoted, so
 * arXiv matches them as terms instead of demanding the exact phrase -- which a
 * whole question almost never is.
 */
export function phrase(query) {
  return query
    .replace(/["\\()\[\]{}]/g, ' ')
    .replace(/\b(?:AND|OR|ANDNOT)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function search(request, config) {
  const startedAt = Date.now();
  const words = phrase(String(request.query ?? ''));
  if (!words) return { latency: 0, rows: [] };

  const feed = await getText(url('https://export.arxiv.org/api/query', {
    search_query: `all:${words}`,
    max_results: Math.min(request.limit ?? 10, 20),
    sortBy: 'relevance',
    sortOrder: 'descending',
  }), { timeoutMs: config.searchTimeoutMs, headers: { accept: 'application/atom+xml' } });

  const entries = feed.match(/<entry>[\s\S]*?<\/entry>/gi) ?? [];
  return {
    latency: Date.now() - startedAt,
    rows: entries.map((entry) => ({
      title: tag(entry, 'title').replace(/\s+/g, ' ').trim(),
      url: tag(entry, 'id'),
      snippet: tag(entry, 'summary').replace(/\s+/g, ' ').trim().slice(0, 400),
    })).filter((row) => row.url.startsWith('http')),
  };
}

export default {
  id: 'arxiv',
  label: 'arXiv',
  capabilities: ['search'],
  search,
};
