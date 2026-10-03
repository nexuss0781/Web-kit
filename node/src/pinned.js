/**
 * HTTP for URLs a caller named.
 *
 * This is the difference between `/v1/fetch` and the provider requests in
 * http.js. Providers are configured by whoever runs the service; this URL came
 * from whoever called it, so the address has to be checked before a byte leaves
 * the machine. `assertPublicHost` does that check.
 *
 * The check is only half the job, and the other half is the reason this file
 * exists. Checking resolves DNS, and then the fetch resolves it again, and
 * nothing makes those two answers the same: an attacker who controls a name
 * with a short TTL can answer the first lookup with a public address and the
 * second with 127.0.0.1. That is DNS rebinding, and it turns a check into a
 * formality that a patient caller walks past.
 *
 * So the address is resolved once here, checked once, and then dialled directly
 * for the rest of the request. The hostname still goes out in the Host header
 * and still goes to TLS as SNI, so the site sees and validates the name that
 * was asked for -- but the connection goes to the address that was verified.
 * There is no second lookup to win.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { UnsafeUrlError, isPrivateAddress } from './safety.js';

/**
 * Resolves a host and refuses it if any address it maps to is private.
 *
 * Every address is checked rather than the first, so a name with one public and
 * one private answer is refused outright rather than being dialled on whichever
 * branch happens to win.
 */
export async function resolvePublic(url) {
  // An IPv6 literal arrives from the URL parser wrapped in brackets, and
  // net.isIP does not accept brackets. Left as they are, [::1] would be treated
  // as a name to resolve instead of the loopback address it plainly is.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError(`refusing a request to a private address: ${host}`);
    return { host, address: host, family: net.isIP(host) };
  }

  let answers;
  try {
    answers = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError(`cannot resolve ${host}`);
  }
  if (answers.length === 0) throw new UnsafeUrlError(`cannot resolve ${host}`);

  for (const { address } of answers) {
    if (isPrivateAddress(address)) {
      throw new UnsafeUrlError(`${host} resolves to a private address (${address}) and is refused`);
    }
  }

  // IPv4 first, for the reason in http.js: a host publishing both records
  // answers reliably on a network that has no IPv6 route, which is most of them.
  const chosen = answers.find((answer) => answer.family === 4) ?? answers[0];
  return { host, address: chosen.address, family: chosen.family };
}

/**
 * One GET, dialled at an address that has already been checked.
 *
 * Returns the shape the rest of the service reads: a status, headers and a
 * body that streams, so a caller can stop reading early and a large page cannot
 * be buffered whole.
 */
export function pinnedGet(url, { headers = {}, timeoutMs = 12_000, maxBytes = Number.MAX_SAFE_INTEGER, resolve = resolvePublic } = {}) {
  const parsed = url instanceof URL ? url : new URL(url);
  const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

  // A resolver may answer with a value or a promise; `Promise.resolve` keeps the
  // test double free to be the simpler of the two.
  return Promise.resolve(resolve(parsed)).then(({ address, family }) => new Promise((done, fail) => {
    const settled = (build) => {
      let value;
      try {
        value = build();
      } catch (error) {
        fail(error);
        return;
      }
      done(value);
    };

    const request = send(
      {
        protocol: parsed.protocol,
        // The verified address, not the name. This is the whole point: the
        // connection cannot end up somewhere the check did not look.
        hostname: address,
        family,
        // The name still goes to TLS, so the certificate is still checked
        // against the host that was asked for. SNI without the hostname
        // dialled would be a check against the wrong thing.
        servername: parsed.protocol === 'https:' ? parsed.hostname : undefined,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          // The site routes on this, and a request whose Host disagrees with
          // the name in the URL is not the request that was asked for.
          host: parsed.host,
          connection: 'close',
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        let received = 0;
        let truncated = false;
        response.on('data', (chunk) => {
          if (truncated) return;
          received += chunk.length;
          // Stop at the socket rather than after buffering, so a hostile or
          // merely enormous response cannot allocate its way to death. What
          // arrived so far is kept, because a long page cut short is still worth
          // reading and saying so is better than returning nothing at all.
          if (received > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(chunk.length - (received - maxBytes), 0)));
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          // settle() rather than a throw: this runs in a socket callback, where
          // an exception would escape the promise and leave the caller waiting
          // on something nobody will ever resolve.
          settled(() => ({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            headers: response.headers,
            body: Buffer.concat(chunks),
            truncated,
          }));
        });
        // `destroy()` with no error still surfaces here as ECONNRESET, and that
        // is the normal ending for a truncated read rather than a fault.
        response.on('error', (error) => (truncated ? settled(() => ({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          headers: response.headers,
          body: Buffer.concat(chunks),
          truncated,
        })) : fail(error)));
      },
    );

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`no answer from ${parsed.hostname} within ${timeoutMs}ms`)));
    request.on('error', fail);
    request.end();
  }));
}

/** Reads one header by name, case-insensitively, from a Node headers object. */
export function header(response, name) {
  const value = response.headers?.[name.toLowerCase()];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(', ') : String(value);
}