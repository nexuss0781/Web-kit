/**
 * SearXNG, when an operator supplies instances that will actually answer.
 *
 * The public instance network mostly refuses JSON and rate limits hard from
 * shared addresses, so this provider is useful when the service is run beside
 * an instance of your own and unhelpful when it is pointed at searx.space. It
 * stays in the registry because that is the case it is good at.
 */

import { getJson, url } from '../http.js';

const DEFAULT_INSTANCES = ['http://searxng:8080'];

async function askInstance(instance, request, config) {
  const startedAt = Date.now();
  const data = await getJson(url(`${instance.replace(/\/+$/, '')}/search`, {
    q: request.query,
    format: 'json',
    language: request.language || undefined,
    safesearch: request.safe_search || undefined,
    time_range: request.time_range || undefined,
  }), {
    timeoutMs: config.searchTimeoutMs,
    headers: { accept: 'application/json' },
  });
  return {
    latency: Date.now() - startedAt,
    rows: (Array.isArray(data.results) ? data.results : []).map((row) => ({
      title: String(row.title ?? '').trim(),
      url: String(row.url ?? '').trim(),
      snippet: String(row.content ?? '').trim(),
    })).filter((row) => row.url),
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
  let answered = 0;
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'fulfilled') {
      answered += 1;
      rows.push(...outcome.value.rows);
    } else {
      warnings.push(`instance ${instances[index]} failed: ${outcome.reason?.message ?? outcome.reason}`);
    }
  }
  if (answered === 0) throw new Error(`no searxng instance answered: ${warnings.join('; ')}`);

  return { rows, latency: Date.now() - startedAt, warnings };
}

export default {
  id: 'searxng',
  label: 'SearXNG',
  capabilities: ['search'],
  /** Off unless instances are configured, because the default is not public. */
  enabledByDefault: (config) => Boolean(config.searxngUrls?.length),
  search,
};
