/**
 * Ports, asked for rather than assumed.
 *
 * Every port in this SDK is a default that anything else on the machine is
 * allowed to have taken already. Failing because 8787 was busy, when 8788 was
 * free, would be a bad first run -- so ask the operating system.
 */

import net from 'node:net';

/** Does anything accept a connection on this address already? */
function accepting(port, host, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Is this port free for a listener on `host`?
 *
 * Two checks, because either one alone lies on Windows. Binding is what Linux
 * uses, and it is authoritative there. On Windows a loopback listener may join
 * an existing wildcard listener on the same port -- the kernel then picks which
 * process answers each connection -- so a successful bind says nothing about
 * whether someone is already there. A connection attempt does: a wildcard
 * listener accepts on loopback too. Both must pass.
 */
export async function portFree(port, host = '127.0.0.1') {
  if (await accepting(port, host)) return false;

  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    // `exclusive` keeps the probe from leaving a reusable address behind.
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function nextFreePort(preferred, { host = '127.0.0.1', span = 20 } = {}) {
  for (let port = preferred; port < preferred + span; port += 1) {
    if (await portFree(port, host)) return port;
  }
  throw new Error(`no free port in ${preferred}-${preferred + span - 1}`);
}

/** Something answering HTTP, within a budget. Health checks should never hang a command. */
export async function fetchJson(url, { timeoutMs = 2500, headers = {} } = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}
