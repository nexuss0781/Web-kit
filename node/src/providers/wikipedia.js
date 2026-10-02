/**
 * Wikipedia's search API. Free, no key, and an official endpoint, which makes it
 * the most dependable thing in this registry.
 */

import { getJson, url } from '../http.js';

const LANGUAGES = {
  en: 'en.wikipedia.org',
  de: 'de.wikipedia.org',
  es: 'es.wikipedia.org',
  fr: 'fr.wikipedia.org',
  ja: 'ja.wikipedia.org',
  pt: 'pt.wikipedia.org',
  ru: 'ru.wikipedia.org',
  zh: 'zh.wikipedia.org',
};

async function search(request, config) {
  const startedAt = Date.now();
  const language = LANGUAGES[(request.language || 'en').slice(0, 2)] ?? LANGUAGES.en;
  const data = await getJson(url(`https://${language}/w/api.php`, {
    action: 'query',
    list: 'search',
    srsearch: request.query,
    srlimit: Math.min(request.limit ?? 10, 20),
    srprop: 'snippet',
    format: 'json',
    formatversion: '2',
  }), { timeoutMs: config.searchTimeoutMs });

  const pages = data?.query?.search ?? [];
  return {
    latency: Date.now() - startedAt,
    rows: pages.map((page) => {
      // The API hands back HTML in the snippet with search terms wrapped in
      // <span>; the text alone is what belongs in a result.
      const snippet = String(page.snippet ?? '').replace(/<[^>]*>/g, '').trim();
      return {
        title: String(page.title ?? ''),
        url: `https://${language}/wiki/${encodeURIComponent(String(page.title).replace(/ /g, '_'))}`,
        snippet,
      };
    }).filter((row) => row.url),
  };
}

export default {
  id: 'wikipedia',
  label: 'Wikipedia',
  capabilities: ['search'],
  search,
};
