/**
 * Decides whether a URL is one this service is willing to fetch.
 *
 * The service fetches whatever it is asked to fetch, which is exactly what makes
 * it useful to an agent and exactly what makes it dangerous: without a check,
 * a caller can use it to reach a database, a metadata endpoint or a service on
 * the machine's own network by naming an address instead of a host.
 *
 * The check has two halves, and both are needed. Resolving the name and testing
 * the address catches `http://127.0.0.1/` and `http://localhost/` and any
 * public-looking host that resolves into private space. But a name can resolve
 * to a public address and then answer with a private one, so every redirect is
 * checked again rather than followed on trust.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
/**
 * Ports worth fetching. The default ports, plus the ones real sites are served
 * on. Anything else -- 22, 3306, 6379 and the rest -- is refused, because a
 * caller who can name a port can reach services that were never meant to be
 * spoken to over HTTP.
 */
const ALLOWED_PORTS = new Set(['', '80', '443', '3000', '5000', '8000', '8080', '8443', '8888', '9000']);

/** Expands any IPv6 spelling to its eight groups, so they can be compared. */
function expandIPv6(address) {
  const halves = address.split('::');
  if (halves.length === 1) return address.split(':');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const fill = 8 - left.length - right.length;
  if (fill < 0) return address.split(':');
  return [...left, ...Array(fill).fill('0'), ...right];
}

/**
 * The IPv4 address hiding inside an IPv6 literal, in either the dotted or the
 * hex spelling. WHATWG URL parsing rewrites ::ffff:127.0.0.1 as ::ffff:7f00:1,
 * so matching only the dotted form would let loopback through as a v6 literal.
 */
function embeddedIPv4(address) {
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted) return dotted[1];
  const groups = expandIPv6(address);
  if (groups.length !== 8) return null;
  const high = parseInt(groups[6], 16);
  const low = parseInt(groups[7], 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return null;
  // ::ffff:0:0/96 (mapped) and ::/96 (deprecated compatible) are the two ways
  // a v4 address hides behind a v6 literal; the sixth group is what tells them
  // apart from an ordinary address.
  const zeroPrefix = groups.slice(0, 5).every((group) => parseInt(group, 16) === 0);
  const sixth = parseInt(groups[5], 16);
  if (!zeroPrefix || (sixth !== 0xffff && sixth !== 0)) return null;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** True for any address that is not a normal public internet destination. */
export function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('ff')) return true; // multicast
    // IPv4 mapped and compatible addresses hide v4 behind a v6 literal.
    const embedded = embeddedIPv4(lower);
    if (embedded) return isPrivateAddress(embedded);
    return false;
  }
  return true; // not an address at all
}

export class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeUrlError';
    this.code = 'E_UNSAFE_URL';
    this.status = 400;
  }
}

/** Checks shape only: protocol, credentials, port. Does not touch the network. */
export function parseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`not a valid URL: ${raw}`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UnsafeUrlError(`only http and https can be fetched, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('a URL carrying credentials is refused');
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UnsafeUrlError(`port ${url.port} is not fetched`);
  }
  return url;
}

/**
 * Resolves the host and refuses the whole request when any address it maps to
 * is private. Checking every address, rather than the first, is deliberate: a
 * name with one public and one private answer must not be fetched.
 */
export async function assertPublicHost(url) {
  // An IPv6 literal reaches us wrapped in brackets, and net.isIP does not accept
  // brackets -- so without this, [::1] falls through to DNS and is reported as
  // an unresolvable name instead of the loopback address it is.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError(`refusing a request to a private address: ${host}`);
    return;
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError(`cannot resolve ${host}`);
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`cannot resolve ${host}`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new UnsafeUrlError(`${host} resolves to a private address (${address}) and is refused`);
    }
  }
}
