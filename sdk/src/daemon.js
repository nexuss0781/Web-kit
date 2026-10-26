/**
 * The daemon, and the process it becomes.
 *
 * `webkit start` spawns `webkit serve` detached and then only waits for
 * `/healthz`. Everything the runtime needs -- SearXNG, the provider ladder, the
 * HTTP surface -- is set up inside that one process, so there is exactly one
 * place where a failure can happen and exactly one log to read.
 *
 * The daemon writes its own `daemon.json`. A parent that records intent before
 * the child is ready would otherwise be able to describe a port nothing is
 * listening on.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, ensureDirs, sleep, tail } from './paths.js';
import { engineEnv, readSettings } from './settings.js';
import { fetchJson, nextFreePort } from './net.js';
import { openEngine } from './engine.js';
import * as searxng from './searxng.js';
import { run } from './run.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'webkit.js');

export function readDaemon() {
  try {
    return JSON.parse(fs.readFileSync(paths.daemon, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Is the recorded daemon still the one answering on that port?
 *
 * The health endpoint names the process that wrote it. Checking that name
 * matters on Windows, where a wildcard listener and a loopback listener can
 * hold the same port at once, so "something answered" is not the same as "our
 * daemon answered".
 */
export async function isRunning(info = readDaemon(), timeoutMs = 1500) {
  if (!info?.url) return false;
  try {
    const { ok, body } = await fetchJson(`${info.url}/healthz`, { timeoutMs });
    if (!ok) return false;
    if (info.instance) return body?.instance === info.instance;
    return true;
  } catch {
    return false;
  }
}

/** Stop a process and everything it started. A daemon owns its Python child. */
async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    // /T because of the Python child; /F because a Node process with an open
    // listener does not always take the polite signal.
    await run('taskkill', ['/pid', String(pid), '/T', '/F'], { timeoutMs: 20_000 }).catch(() => {});
  } else {
    try {
      // The daemon was spawned detached, so it leads its own process group.
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
}

/**
 * Start the daemon unless one is already answering.
 *
 * `port` can move: a machine is allowed to have something on 8787. The caller
 * gets the record, not its own guess.
 */
export async function start(settings = readSettings(), { log = () => {} } = {}) {
  ensureDirs();

  const existing = readDaemon();
  if (existing && await isRunning(existing)) return existing;

  const port = await nextFreePort(settings.port);
  if (port !== settings.port) log(`port ${settings.port} is in use; the engine will listen on ${port}`);

  const env = engineEnv({ ...settings, port });
  env.WEBKIT_DAEMON = '1';
  // A name this start can recognise. See `isRunning`.
  const instance = crypto.randomUUID();
  env.WEBKIT_INSTANCE = instance;

  const logFd = fs.openSync(paths.daemonLog, 'a');
  const child = spawn(process.execPath, [bin, 'serve'], {
    cwd: paths.home,
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  const url = `http://${settings.host}:${port}`;
  const deadline = Date.now() + 120_000;
  let own = null;

  // The child writes daemon.json only after its listener is open, so a record
  // carrying this pid and this instance is proof of this start, not of a
  // leftover file or of whatever else may be holding the port.
  while (Date.now() < deadline) {
    const info = readDaemon();
    if (info?.pid === child.pid && info.instance === instance) {
      own = info;
      break;
    }
    if (child.exitCode !== null) break;
    await sleep(200);
  }

  if (!own) {
    await fail('the local engine did not start');
  }

  // It has a record, so it is listening. It now has to be the one that answers:
  // if a wildcard listener arrived first, the port is shared and this is the
  // moment to say so instead of handing the caller a 401 from a stranger.
  const settle = Date.now() + 15_000;
  let stranger = null;
  while (Date.now() < settle) {
    const health = await fetchJson(`${url}/healthz`, { timeoutMs: 1500 }).catch(() => null);
    if (health?.body?.instance === instance) return own;
    if (health?.ok && health.body?.instance !== instance) {
      stranger = health.body;
      break;
    }
    if (child.exitCode !== null) break;
    await sleep(200);
  }

  await fail(stranger
    ? `port ${port} is held by another service: ${url}/healthz answers, but not as this daemon.\n`
      + 'Stop that service, or start on a free port with `webkit start --port 8788`.'
    : `the local engine started but did not answer on ${url}`);

  /** Undo this start, then report. Only the record this start wrote is removed. */
  async function fail(message) {
    await killTree(child.pid);
    const recorded = readDaemon();
    if (recorded?.pid === child.pid) fs.rmSync(paths.daemon, { force: true });
    const detail = stranger ? '' : tail(paths.daemonLog, 25);
    throw new Error(
      `${message}${detail ? `\n\n${detail}` : ''}\n\nRun \`webkit doctor\` or \`webkit serve\` to see it in the foreground.`,
    );
  }
}

/**
 * Does the recorded pid still look like the process we started?
 *
 * Pid files outlive crashes, and pids are recycled. `taskkill /F` on a pid that
 * now belongs to something else would be a much worse bug than leaving a
 * daemon behind, so the name is checked before the signal.
 */
async function pidLooksOurs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'win32') {
    const result = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 10_000 });
    return /"node\.exe"/i.test(result.stdout);
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('webkit');
  } catch {
    // No procfs (macOS): the pid exists and the file says it is ours.
    return true;
  }
}

export async function stop() {
  const info = readDaemon();
  if (!info) return false;

  if (!(await isRunning(info, 800)) && !(await pidLooksOurs(info.pid))) {
    fs.rmSync(paths.daemon, { force: true });
    return false;
  }

  await killTree(info.pid);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await isRunning(info, 800))) break;
    await sleep(200);
  }

  fs.rmSync(paths.daemon, { force: true });
  return true;
}

/**
 * The process behind `webkit serve`, in the foreground or as the daemon.
 *
 * Failures are asymmetric on purpose. A broken SearXNG is degraded service --
 * the free index and the verticals still answer -- so it is reported and
 * stepped over. A failure to open the HTTP listener is fatal, because there is
 * nothing left to serve.
 */
export async function serve(settings, { log = () => {} } = {}) {
  ensureDirs();
  let active = { ...settings };

  if (active.searxng) {
    if (!searxng.installed()) {
      log('SearXNG is not installed; serving without the local index. Run `webkit setup` to add it.');
      active = { ...active, searxng: false };
    } else {
      try {
        const started = await searxng.start(active, { log });
        active = { ...active, searxngPort: started.port };
        log(`SearXNG ${started.reused ? 'reused' : 'started'} on 127.0.0.1:${started.port}`);
      } catch (error) {
        log(`SearXNG failed to start, continuing without it: ${error.message}`);
        active = { ...active, searxng: false };
      }
    }
  }

  let engine;
  try {
    engine = await openEngine(active);
  } catch (error) {
    // Nothing is listening, so an orphaned Python process would be invisible
    // and permanent. Undo what this process started before reporting why.
    await searxng.stop().catch(() => {});
    fs.rmSync(paths.daemon, { force: true });
    throw error;
  }
  const info = {
    pid: process.pid,
    port: active.port,
    url: engine.url,
    searxngPort: active.searxng ? active.searxngPort : null,
    startedAt: new Date().toISOString(),
    // Echoed by /healthz, so the parent can tell this daemon from any other
    // process that may be sharing the port.
    instance: engine.config.instance,
  };
  fs.writeFileSync(paths.daemon, `${JSON.stringify(info, null, 2)}\n`);

  log(`listening on ${engine.url}`);
  log(`tiers: ${(engine.config.searchTiers.length ? engine.config.searchTiers : ['searxng', 'firecrawl-keyless', 'verticals', 'firecrawl-key']).join(' -> ')}`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log(`${signal} received, shutting down`);
    await engine.close().catch(() => {});
    await searxng.stop().catch(() => {});
    fs.rmSync(paths.daemon, { force: true });
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Nothing else to do; the listeners keep the process alive.
  await new Promise(() => {});
}
