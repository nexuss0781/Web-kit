/**
 * The small amount of HTTP the providers need.
 *
 * Provider endpoints are fixed and configured by whoever runs the service, not
 * named by callers, so these URLs never need the SSRF checks that /v1/fetch
 * applies. What they do need is a ceiling: one slow or hostile upstream must not
 * be able to hold a search open, and one enormous response must not be able to
 * take the process down.
 *
 * They also need the address family pinned. Most of these hosts publish both an
 * A and an AAAA record, and on a network without IPv6 route -- which is most
 * single homed machines and some containers -- the AAAA branch is the one that
 * gets dialled, fails, and takes the whole provider down with it. Measured
 * against wikipedia.org from such a machine: `fetch` raises
 * `AggregateError [ETIMEDOUT]` while the same request pinned to IPv4 succeeds in
 * well under a second. Search output is only as good as its luckiest upstream,
 * so the family is chosen here instead of being raced for.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';

const DEFAULT_TIMEOUT_MS = 8_000;
const USER_AGENT = 'Web-Kit/0.1 (+https://github.com/nexuss0781/Web-kit)';

/** No provider answer is worth more than this, and none is expected to be close. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Builds a URL from a base and a query, encoding every value. */
export function url(base, params = {}) {
  const target = new URL(base);
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    target.searchParams.set(name, String(value));
  }
  return target.href;
}

/**
 * Resolved families, remembered per host. A search asks six providers on every
 * request and the answer cannot usefully change within a run.
 */
const families = new Map();

async function familyFor(hostname) {
  const cached = families.get(hostname);
  if (cached) return cached;

  const pending = lookup(hostname, { all: true }).then((answers) => {
    if (answers.length === 0) throw new Error(`could not resolve ${hostname}`);
    // IPv4 when the host has it, and otherwise whatever it does have, so a
    // genuinely IPv6-only host still works.
    return (answers.find((answer) => answer.family === 4) ?? answers[0]).family;
  });

  families.set(hostname, pending);
  // A name that did not resolve may resolve next time; do not cache the miss.
  pending.catch(() => families.delete(hostname));
  return pending;
}

/**
 * One GET, answered or refused.
 *
 * The hostname stays the hostname, so TLS still receives the right SNI and the
 * certificate is still checked against the name that was asked for; only the
 * family of the address dialled is decided here.
 */
async function get(target, { timeoutMs, headers }) {
  const parsed = new URL(target);
  const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  const family = await familyFor(parsed.hostname);

  return new Promise((resolve, reject) => {
    const request = send(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        family,
        servername: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'en', ...headers },
      },
      (response) => {
        const chunks = [];
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          // Refuse at the socket rather than after buffering, so an upstream
          // cannot make this process allocate its way to death.
          if (received > MAX_RESPONSE_BYTES) {
            request.destroy(new Error(`response from ${parsed.hostname} exceeds ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      },
    );

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`no answer from ${parsed.hostname} within ${timeoutMs}ms`)));
    request.on('error', reject);
    request.end();
  });
}

/** GETs and requires a 2xx, then hands back the parsed JSON. */
export async function getJson(target, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const response = await get(target, { timeoutMs, headers: { accept: 'application/json', ...headers } });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error(`${hostnameOf(target)} did not answer with JSON`);
  }
}

/** GETs and requires a 2xx, then hands back the text. Used by the Atom provider. */
export async function getText(target, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const response = await get(target, { timeoutMs, headers });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.body;
}

function hostnameOf(target) {
  try {
    return new URL(target).hostname;
  } catch {
    return 'the upstream';
  }
}

export { DEFAULT_TIMEOUT_MS, USER_AGENT };
