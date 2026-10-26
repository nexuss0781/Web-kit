/**
 * SearXNG, when an operator supplies instances that will actually answer.
 *
 * This is the SDK's primary index, and it is asked for everything the
 * metasearch API exposes rather than the four fields a generic client needs:
 *
 * - `categories` and `engines` are how one instance becomes news for a market
 *   question, `science` for a paper question, and `it` for a code question.
 *   Without them every query gets the same general tab, which is why a
 *   metasearch backend looks weak next to a purpose-built index.
 * - `pageno` is depth. Deep research needs pages two and three.
 * - `answers`, `infoboxes`, `suggestions` and `unresponsive_engines` say what
 *   the instance knew before it ranked anything, and which engines are dead.
 *   Discarding them is how a query silently loses half its sources.
 *
 * The public instance network mostly refuses JSON and rate limits hard from
 * shared addresses, so this provider is at its best beside an instance of your
 * own -- which is exactly the arrangement the SDK creates.
 */

import { getJson, url } from '../http.js';

const DEFAULT_INSTANCES = ['http://127.0.0.1:8888'];

/** SearXNG categories from the words callers actually use. */
const CATEGORY_ALIASES = new Map([
  ['general', 'general'], ['web', 'general'],
  ['news', 'news'],
  ['images', 'images'], ['image', 'images'],
  ['science', 'science'], ['papers', 'science'], ['research', 'science'], ['academic', 'science'],
  ['it', 'it'], ['code', 'it'], ['developer', 'it'], ['github', 'it'],
  ['files', 'files'], ['pdf', 'files'],
  ['social', 'social media'], ['social media', 'social media'],
  ['videos', 'videos'], ['video', 'videos'],
]);

/** `safesearch` is 0/1/2, but callers name it. */
const SAFE = new Map([
  ['off', '0'], ['none', '0'], ['0', '0'],
  ['moderate', '1'], ['medium', '1'], ['1', '1'],
  ['strict', '2'], ['on', '2'], ['2', '2'],
]);

function listOf(value) {
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((entry) => String(entry ?? '').trim().toLowerCase())
    .filter(Boolean);
}

/** Known names are translated; unknown ones are left for the instance to reject. */
export function categoriesFor(value) {
  const named = listOf(value);
  if (named.length === 0) return [];
  return [...new Set(named.map((name) => CATEGORY_ALIASES.get(name) ?? name))];
}

/**
 * One instance answering one query.
 *
 * The raw response is kept alongside the tidy rows because the caller may want
 * the parts that have no row: a direct answer, an infobox, the list of engines
 * that timed out. Those are dropped by the time a row exists, and they are
 * often the whole answer.
 */
async function askInstance(instance, request, config) {
  const startedAt = Date.now();
  const categories = categoriesFor(request.categories);
  const engines = listOf(request.engines);
  const safe = SAFE.get(String(request.safe_search ?? request.safesearch ?? '').toLowerCase());

  const data = await getJson(url(`${instance.replace(/\/+$/, '')}/search`, {
    q: request.query,
    format: 'json',
    language: request.language || undefined,
    safesearch: safe,
    time_range: request.time_range || undefined,
    categories: categories.length ? categories.join(',') : undefined,
    engines: engines.length ? engines.join(',') : undefined,
    pageno: request.pageno && Number(request.pageno) > 1 ? String(request.pageno) : undefined,
  }), {
    timeoutMs: config.searchTimeoutMs,
    headers: { accept: 'application/json' },
  });

  const rows = (Array.isArray(data.results) ? data.results : []).map((row) => ({
    title: String(row.title ?? '').trim(),
    url: String(row.url ?? '').trim(),
    snippet: String(row.content ?? '').trim(),
    // Kept so a caller can split news from general without a second query, and
    // so a result that only one engine found is distinguishable from one that
    // several agreed on.
    category: row.category ?? null,
    engine: row.engine ?? null,
    engines: Array.isArray(row.engines) ? row.engines : (row.engine ? [row.engine] : []),
    published_at: row.publishedDate ?? null,
    score: typeof row.score === 'number' ? row.score : null,
  })).filter((row) => row.url);

  return {
    latency: Date.now() - startedAt,
    rows,
    answers: (Array.isArray(data.answers) ? data.answers : []).map((answer) => ({
      answer: String(answer.answer ?? '').trim(),
      url: answer.url ?? null,
    })).filter((answer) => answer.answer),
    infoboxes: Array.isArray(data.infoboxes) ? data.infoboxes : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    unresponsive: Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : [],
  };
}

/**
 * One searxng provider, fanned out across its own instances. Fanout here is
 * about redundancy as much as ranking: several instances answering is the only
 * way the provider survives any one of them rate limiting us.
 */
async function search(request, config) {
  const instances = config.searxngUrls?.length ? config.searxngUrls : DEFAULT_INSTANCES;
  const startedAt = Date.now();
  const settled = await Promise.allSettled(instances.map((instance) => askInstance(instance, request, config)));

  const rows = [];
  const warnings = [];
  const answers = [];
  const infoboxes = [];
  const suggestions = [];
  const unresponsive = [];
  let answered = 0;

  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'fulfilled') {
      answered += 1;
      rows.push(...outcome.value.rows);
      answers.push(...outcome.value.answers);
      infoboxes.push(...outcome.value.infoboxes);
      suggestions.push(...outcome.value.suggestions);
      for (const [engine, reason] of outcome.value.unresponsive) {
        unresponsive.push({ engine, reason });
      }
    } else {
      warnings.push(`instance ${instances[index]} failed: ${outcome.reason?.message ?? outcome.reason}`);
    }
  }
  if (answered === 0) throw new Error(`no searxng instance answered: ${warnings.join('; ')}`);

  // One engine timing out is not a broken instance, but it is a reason a query
  // has fewer sources than it looks like it should.
  const dead = [...new Set(unresponsive.map((entry) => entry.engine))];
  if (dead.length) warnings.push(`engines did not answer: ${dead.slice(0, 8).join(', ')}`);

  return {
    rows,
    latency: Date.now() - startedAt,
    warnings,
    answers,
    infoboxes,
    suggestions,
    unresponsive,
  };
}

export default {
  id: 'searxng',
  label: 'SearXNG',
  capabilities: ['search'],
  /** Off unless instances are configured, because the default is not public. */
  enabledByDefault: (config) => Boolean(config.searxngUrls?.length),
  search,
};
