/**
 * The small amount of HTTP the providers need.
 *
 * Provider endpoints are fixed and configured by whoever runs the service, not
 * named by callers, so these URLs never need the SSRF checks that /v1/fetch
 * applies. What they do need is a ceiling: one slow or hostile upstream must not
 * be able to hold a search open.
 */

const DEFAULT_TIMEOUT_MS = 8_000;
const USER_AGENT = 'Web-Kit/0.1 (+https://github.com/nexuss0781/Web-kit)';

/** Builds a URL from a base and a query, encoding every value. */
export function url(base, params = {}) {
  const target = new URL(base);
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    target.searchParams.set(name, String(value));
  }
  return target.href;
}

/** GETs JSON, or throws. Timeouts are the caller's to choose. */
export async function getJson(target, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const response = await fetch(target, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      'accept-language': 'en',
      ...headers,
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/** GETs text, or throws. Used by the one provider that speaks Atom. */
export async function getText(target, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const response = await fetch(target, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': USER_AGENT, 'accept-language': 'en', ...headers },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

export { DEFAULT_TIMEOUT_MS, USER_AGENT };
