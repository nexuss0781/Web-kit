/**
 * The provider registry.
 *
 * Everything here is a free, keyless, official API. That is a deliberate filter
 * rather than an accident: the public SearXNG network turns out to refuse JSON
 * from most callers and rate limits the rest, so a service that leans on it
 * works on the author's machine and nowhere else. These endpoints answer.
 */

import searxng from './searxng.js';
import wikipedia from './wikipedia.js';
import arxiv from './arxiv.js';
import hackernews from './hackernews.js';
import github from './github.js';
import { openlibrary, crossref } from './library.js';

const ALL = [wikipedia, hackernews, arxiv, github, crossref, openlibrary, searxng];

const BY_ID = new Map(ALL.map((provider) => [provider.id, provider]));

/** A provider that asked to be left out when its own config is absent. */
const isAvailable = (provider, config) => (provider.enabledByDefault ? provider.enabledByDefault(config) : true);

export function allProviders() {
  return ALL;
}

/** The default set for this deployment, in the order results are fused. */
/**
 * Resolves the configured list. Entries may be ids or provider objects, which is
 * how a private deployment supplies something the registry has never heard of
 * and how the mode behaviour is tested without a network.
 */
export function enabledProviders(config) {
  const requested = config.providers?.length ? config.providers : null;
  const chosen = requested
    ? requested.map((entry) => (typeof entry === 'string' ? BY_ID.get(entry) : entry)).filter(Boolean)
    : ALL.filter((provider) => isAvailable(provider, config));
  return chosen.filter((provider) => isAvailable(provider, config));
}

/** What /v1/providers reports: what exists, and what this deployment will use. */
export function describeProviders(config) {
  const enabled = new Set(enabledProviders(config).map((provider) => provider.id));
  return ALL.map((provider) => ({
    id: provider.id,
    label: provider.label,
    capabilities: provider.capabilities,
    enabled: enabled.has(provider.id),
  }));
}

export function getProvider(id) {
  return BY_ID.get(id) ?? null;
}
