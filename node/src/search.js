/**
 * Search across providers: run them, then reconcile what they say.
 *
 * The interesting part is not the querying, it is the agreeing. Different
 * providers know different things, and a result several of them returned is a
 * better bet than one that only appeared once, so scores are fused by reciprocal
 * rank and duplicates collapse onto a single entry.
 */

import crypto from 'node:crypto';
import { canonicalUrl } from './html.js';
import { enabledProviders } from './providers/index.js';

/** Reciprocal rank fusion: a result's score is the sum of 1/(k + rank). */
const FUSION_K = 60;

export function normalise(row, provider, rank) {
  const url = String(row?.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const title = String(row?.title ?? '').replace(/\s+/g, ' ').trim();
  const snippet = String(row?.snippet ?? '').replace(/\s+/g, ' ').trim();
  return {
    title: title || url,
    url,
    canonical_url: canonicalUrl(url) || url,
    snippet: snippet || null,
    provider,
    rank,
    providers: [provider],
    provider_ranks: { [provider]: rank },
  };
}

/**
 * Merges results that point at the same page. Tracking parameters go first, so
 * the same article found by three providers is one result with three opinions
 * about where it ranks.
 */
export function fuse(rows) {
  const byCanonical = new Map();
  for (const row of rows) {
    const existing = byCanonical.get(row.canonical_url);
    if (!existing) {
      byCanonical.set(row.canonical_url, { ...row });
      continue;
    }
    existing.score += row.score;
    if (!existing.providers.includes(row.provider)) {
      existing.providers.push(row.provider);
      existing.provider_ranks[row.provider] = row.rank;
    }
    // Keep whichever provider said something about the page, not whichever said
    // it first, so the snippet is the most informative one available.
    if ((row.snippet?.length ?? 0) > (existing.snippet?.length ?? 0)) existing.snippet = row.snippet;
    if ((row.title?.length ?? 0) > (existing.title?.length ?? 0)) existing.title = row.title;
  }

  return [...byCanonical.values()]
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

const answered = (provider, rows, latency, warnings) => ({
  provider,
  rows: rows.map((row, index) => ({ ...row, score: 1 / (FUSION_K + index + 1) })),
  status: rows.length ? 'ok' : 'empty',
  latency,
  warnings,
});

export async function search(request = {}, config = {}) {
  const startedAt = Date.now();
  const mode = ['single', 'fallback', 'fanout'].includes(request.mode) ? request.mode : 'fanout';
  const limit = Math.min(Math.max(Number(request.limit) || 10, 1), 100);
  const query = String(request.query ?? '').trim();
  if (!query) throw new Error('query is required');

  const candidates = enabledProviders(config);
  const asked = request.providers?.length
    ? candidates.filter((provider) => request.providers.includes(provider.id))
    : candidates;

  if (asked.length === 0) {
    throw Object.assign(new Error('no provider is enabled for this deployment'), { code: 'E_NO_PROVIDER' });
  }

  const warnings = [];
  const statuses = {};
  const collected = [];
  let tried = 0;

  const run = async (provider) => {
    tried += 1;
    try {
      const result = await provider.search({ ...request, query, limit }, config);
      return answered(provider.id, (result.rows ?? []).map((row, index) => normalise(row, provider.id, index + 1)).filter(Boolean),
        result.latency ?? null, result.warnings ?? []);
    } catch (error) {
      return { provider: provider.id, rows: [], status: 'unreachable', latency: null, error: error.message, warnings: [] };
    }
  };

  if (mode === 'fanout') {
    const settled = await Promise.all(asked.map(run));
    for (const outcome of settled) {
      statuses[outcome.provider] = {
        status: outcome.status,
        latency_ms: outcome.latency,
        result_count: outcome.rows.length,
        error: outcome.error ?? null,
      };
      if (outcome.error) warnings.push(`${outcome.provider} failed: ${outcome.error}`);
      warnings.push(...outcome.warnings);
      collected.push(...outcome.rows);
    }
  } else {
    // single and fallback both stop at the first provider with something to say;
    // what separates them is that fallback keeps going past a provider that
    // answered with nothing.
    for (const provider of asked) {
      const outcome = await run(provider);
      statuses[outcome.provider] = {
        status: outcome.status,
        latency_ms: outcome.latency,
        result_count: outcome.rows.length,
        error: outcome.error ?? null,
      };
      if (outcome.error) {
        warnings.push(`${outcome.provider} failed: ${outcome.error}`);
        continue;
      }
      warnings.push(...outcome.warnings);
      collected.push(...outcome.rows);
      // single means exactly one provider, whatever it had to say. fallback
      // keeps going past an empty or broken one until something has results.
      if (mode === 'single' || outcome.rows.length) break;
    }
  }

  const worked = Object.values(statuses).filter((status) => status.status === 'ok').length;
  if (worked === 0) {
    warnings.push('no provider returned a result');
  }

  return {
    request_id: crypto.randomUUID(),
    query,
    mode,
    results: fuse(collected).slice(0, limit),
    providers: statuses,
    warnings,
    timing: { duration_ms: Date.now() - startedAt, providers_asked: asked.length, providers_answered: worked },
  };
}

export { enabledProviders };
