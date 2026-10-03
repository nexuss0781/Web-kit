/**
 * Reads robots.txt and answers whether a path may be fetched.
 *
 * Implemented to the part of the standard that changes the answer in practice:
 * User-agent groups, Allow, Disallow, and the longest-match rule, where Allow
 * wins a tie. A missing or unreachable robots.txt is treated as permission,
 * because that is what the standard says and because failing closed would make
 * the service useless on any site with a broken file.
 */

import { parseUrl } from './safety.js';
import { pinnedGet, header } from './pinned.js';

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * A robots rule is a path prefix, not a whole path: `Disallow: /private` covers
 * everything under /private, which is the whole point of the directive. Only a
 * rule that ends in $ is asking for an exact match, and that $ has to be kept
 * out of the pattern instead of being read as an anchor wherever it appears.
 */
function ruleMatches(pattern, path) {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

export function parseRobots(text, agent) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one set of rules, which is why a
      // group cannot be closed until a rule appears.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      if (!current) continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
      lastWasAgent = false;
    }
  }

  // A file may split the same agent across several groups, and their rules are
  // meant to be combined rather than picked from. A named group beats the
  // wildcard outright: if a site has an opinion about us specifically, that is
  // the opinion that counts.
  const agentLower = agent.toLowerCase();
  const named = groups.filter((group) => group.agents.some((name) => name !== '*' && agentLower.includes(name)));
  const selected = named.length ? named : groups.filter((group) => group.agents.includes('*'));
  return selected.flatMap((group) => group.rules);
}

export function isAllowed(rules, path) {
  let winner = null;
  let winnerLength = -1;
  for (const rule of rules) {
    if (!ruleMatches(rule.pattern, path)) continue;
    // Longest match wins; Allow beats Disallow at equal length.
    if (rule.pattern.length > winnerLength || (rule.pattern.length === winnerLength && rule.allow)) {
      winner = rule.allow;
      winnerLength = rule.pattern.length;
    }
  }
  return winner ?? true;
}

async function robotsFor(origin, agent, timeoutMs) {
  const cached = cache.get(origin);
  if (cached && cached.expires > Date.now()) return cached.value;

  const value = await (async () => {
    try {
      let url = parseUrl(`${origin}/robots.txt`);
      let response = null;
      for (let hop = 0; hop <= 3; hop += 1) {
        // Dialled at a checked address, for the same reason the fetcher does it:
        // robots.txt is fetched from a caller-named origin, so resolving the
        // name once and connecting somewhere else is exactly the gap this closes.
        response = await pinnedGet(url, {
          timeoutMs: Math.min(timeoutMs, 5000),
          maxBytes: 500_000,
          headers: { 'user-agent': agent, accept: 'text/plain' },
        });
        const location = header(response, 'location');
        if (!location || response.status < 300 || response.status >= 400) break;
        // Every hop is checked: a redirect to a private address would otherwise
        // let robots.txt reach into the network the fetcher refuses to touch.
        url = parseUrl(new URL(location, url).href);
      }
      if (response.status < 200 || response.status >= 300) return [];
      return parseRobots((response.body ?? Buffer.alloc(0)).toString('utf8'), agent);
    } catch {
      return [];
    }
  })();

  cache.set(origin, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

/** True when robots.txt permits this path for our agent. */
export async function permitted(url, agent, timeoutMs = 12_000) {
  const parsed = parseUrl(url);
  const rules = await robotsFor(parsed.origin, agent, timeoutMs);
  return isAllowed(rules, parsed.pathname + parsed.search);
}
