/**
 * GitHub repository search. Unauthenticated it is limited to ten requests a
 * minute per address, which is why a token is read when one is configured.
 */

import { getJson, url } from '../http.js';

async function search(request, config) {
  const startedAt = Date.now();
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;

  const data = await getJson(url('https://api.github.com/search/repositories', {
    q: request.query,
    per_page: Math.min(request.limit ?? 10, 20),
    sort: 'best-match',
  }), { timeoutMs: config.searchTimeoutMs, headers });

  const rows = (data.items ?? []).map((repo) => {
    const parts = [];
    if (repo.language) parts.push(repo.language);
    if (repo.stargazers_count) parts.push(`${repo.stargazers_count.toLocaleString('en')} stars`);
    if (repo.description) parts.push(repo.description);
    return {
      title: `${repo.full_name}`,
      url: repo.html_url,
      snippet: parts.join(' · ').slice(0, 400),
    };
  });

  const warnings = [];
  const remaining = data.rate?.remaining ?? null;
  if (typeof remaining === 'number' && remaining <= 1) {
    warnings.push('github is nearly out of unauthenticated requests; set WEBKIT_GITHUB_TOKEN');
  }
  return { latency: Date.now() - startedAt, rows, warnings };
}

export default {
  id: 'github',
  label: 'GitHub',
  capabilities: ['search'],
  search,
};
