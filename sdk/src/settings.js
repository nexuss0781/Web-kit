/**
 * The SDK's own settings, and how they become the engine's environment.
 *
 * Two layers, on purpose:
 *
 * - `~/.webkit/config.json` is what the user chose and survives restarts.
 * - the environment is what this invocation overrides, and never gets written.
 *
 * The engine has always been configured by `WEBKIT_*` variables, so rather than
 * inventing a second configuration format the SDK translates its settings into
 * exactly those variables and hands them to the same `loadConfig`. One engine,
 * one schema, two entry points.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { paths, ensureDirs } from './paths.js';

export const DEFAULTS = Object.freeze({
  /** Engine address. Loopback because this is a local library, not a service. */
  host: '127.0.0.1',
  port: 8787,
  /** Empty means no token: loopback-only, so a token would protect nothing. */
  token: null,
  /** Whether the SDK runs the local metasearch instance. */
  searxng: true,
  searxngPort: 8888,
  /** Start the daemon automatically for one-shot commands. */
  autoStart: true,
});

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value));
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readSettings() {
  ensureDirs();

  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    // A missing or malformed config is the first-run case, not an error: the
    // defaults are a working installation.
  }

  const env = process.env;
  return {
    host: env.WEBKIT_BIND || file.host || DEFAULTS.host,
    port: integer(env.WEBKIT_PORT, integer(file.port, DEFAULTS.port)),
    token: env.WEBKIT_API_TOKEN || file.token || DEFAULTS.token,
    searxng: bool(env.WEBKIT_SEARXNG, file.searxng ?? DEFAULTS.searxng),
    searxngPort: integer(env.WEBKIT_SEARXNG_PORT, integer(file.searxngPort, DEFAULTS.searxngPort)),
    autoStart: env.WEBKIT_NO_AUTOSTART ? false : bool(file.autoStart, DEFAULTS.autoStart),
  };
}

/** Writes only the keys the caller named, so an override in the environment is not frozen into disk. */
export function writeSettings(patch) {
  ensureDirs();
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    // first write
  }
  const next = { ...current, ...patch };
  fs.writeFileSync(paths.config, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

export function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/** True when a Firecrawl URL points back at this SDK rather than upstream. */
function isSelf(value, settings) {
  try {
    const target = new URL(value);
    const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname);
    const port = target.port ? Number(target.port) : (target.protocol === 'https:' ? 443 : 80);
    return local && port === settings.port;
  } catch {
    return false;
  }
}

/**
 * The environment the engine reads.
 *
 * `FIRECRAWL_API_URL` is the interesting one. The Firecrawl CLI reads it to
 * decide *where to send requests*, and the engine reads it to decide *where to
 * forward requests*. Those are opposite directions with the same name, so
 * pointing the CLI at the SDK would otherwise make the SDK call itself in a
 * loop. The engine therefore reads `WEBKIT_FIRECRAWL_UPSTREAM`, and the SDK
 * strips the CLI-facing variable from the engine's environment.
 */
export function engineEnv(settings, base = process.env) {
  const env = { ...base };

  env.WEBKIT_HOST = settings.host;
  env.WEBKIT_PORT = String(settings.port);
  if (settings.token) env.WEBKIT_API_TOKEN = settings.token;
  else delete env.WEBKIT_API_TOKEN;

  for (const key of ['WEBKIT_SEARXNG_URL', 'WEBKIT_SEARXNG_URLS']) delete env[key];
  // The daemon re-reads its settings from this environment, so a flag the
  // parent applied has to be written down here or the child silently disagrees.
  env.WEBKIT_SEARXNG = settings.searxng ? '1' : '0';
  env.WEBKIT_SEARXNG_PORT = String(settings.searxngPort);
  if (settings.searxng) {
    env.WEBKIT_SEARXNG_URLS = `http://127.0.0.1:${settings.searxngPort}`;
  }

  // The ladder, in the order the user asked for: local first, free index
  // second, verticals as the backstop, a keyed call only when all three are
  // genuinely short. A user can still replace it with WEBKIT_SEARCH_TIERS.
  env.WEBKIT_SEARCH_TIERS = env.WEBKIT_SEARCH_TIERS
    || 'searxng,firecrawl-keyless,verticals,firecrawl-key';
  env.WEBKIT_SEARCH_MIN_RESULTS = env.WEBKIT_SEARCH_MIN_RESULTS || '3';
  env.WEBKIT_KEYLESS_FIRECRAWL = env.WEBKIT_KEYLESS_FIRECRAWL ?? '1';

  const upstream = base.WEBKIT_FIRECRAWL_UPSTREAM || base.FIRECRAWL_API_URL;
  delete env.FIRECRAWL_API_URL;
  if (upstream && !isSelf(upstream, settings)) env.WEBKIT_FIRECRAWL_UPSTREAM = upstream;
  else delete env.WEBKIT_FIRECRAWL_UPSTREAM;

  return env;
}

/** The variables a shell needs so that `firecrawl` and the skills talk to us. */
export function connectEnv(settings) {
  const url = `http://${settings.host}:${settings.port}`;
  const env = { FIRECRAWL_API_URL: url };
  if (settings.token) env.FIRECRAWL_API_KEY = settings.token;
  return env;
}
