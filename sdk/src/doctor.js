/**
 * `webkit doctor`: whether this installation can answer a query, and why not.
 *
 * The point is not to enumerate what is installed. It is to answer one
 * question -- will a search work, and which tier will answer it -- with a line
 * per dependency and the exact command that fixes the first broken one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { paths, venvPython } from './paths.js';
import { readSettings, engineEnv } from './settings.js';
import { findPython, state, healthy } from './searxng.js';
import { readDaemon, isRunning } from './daemon.js';
import { createClient } from './client.js';
import { fetchJson } from './net.js';
import { run } from './run.js';

function sourceInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.searxng, 'webkit-source.json'), 'utf8'));
  } catch {
    return null;
  }
}

export async function doctor({ probe = true, settings = readSettings() } = {}) {
  const rows = [];
  const add = (name, ok, detail = '', fatal = true) => {
    rows.push({ name, ok, detail, fatal });
    return ok;
  };

  const [major] = process.versions.node.split('.').map(Number);
  add('node', major >= 20, `${process.version}${major >= 20 ? '' : ' (20 or newer is required)'}`);
  add('home', true, paths.home);

  let python = null;
  try {
    python = await findPython();
    add('python', true, `${python.version} (${python.executable})`);
  } catch (error) {
    add('python', false, error.message);
  }

  const current = state();
  const info = sourceInfo();
  add(
    'searxng source',
    current.source,
    current.source
      ? `${info?.ref ?? 'unknown ref'}${info?.fetchedAt ? `, fetched ${info.fetchedAt.slice(0, 10)}` : ''} in ${paths.searxng}`
      : 'not installed; run `webkit setup`',
  );
  add(
    'searxng environment',
    current.venv && current.deps,
    current.venv && current.deps ? paths.searxngVenv : 'not installed; run `webkit setup`',
  );

  if (current.venv && current.deps) {
    const imports = await run(venvPython(), ['-c', 'import searx, flask, curl_cffi, tzdata'], {
      cwd: paths.searxng,
      timeoutMs: 60_000,
    });
    add('searxng imports', imports.code === 0, imports.code === 0 ? 'searx, flask, curl_cffi, tzdata' : imports.stderr.trim().split(/\r?\n/).slice(-3).join('\n'));
  }

  add(
    'searxng settings',
    current.settings,
    current.settings ? `${paths.searxngSettings} (port ${settings.searxngPort})` : 'not written; `webkit start` will create it',
  );

  const searxUp = current.venv ? await healthy(settings.searxngPort) : false;
  add(
    'searxng live',
    searxUp,
    searxUp ? `http://127.0.0.1:${settings.searxngPort}` : 'not answering; `webkit start` runs it, `webkit setup` installs it',
    false,
  );

  const record = readDaemon();
  const up = await isRunning(record);
  add('engine', up, up ? `${record.url} (pid ${record.pid})` : 'not running; `webkit start`', true);

  if (up) {
    try {
      const ready = await fetchJson(`${record.url}/readyz`, { timeoutMs: 4000 });
      add('readyz', ready.ok, ready.body ? `providers=${ready.body.providers} keyless=${ready.body.keyless_firecrawl} auth=${ready.body.auth_required}` : `HTTP ${ready.status}`);
    } catch (error) {
      add('readyz', false, error.message);
    }
  }

  const env = engineEnv(settings);
  add('tiers', true, env.WEBKIT_SEARCH_TIERS);

  if (probe) {
    try {
      const client = await createClient({ settings, inProcess: !up });
      const startedAt = Date.now();
      const result = await client.search({ query: 'node.js fetch api documentation', limit: 3 });
      const elapsed = Date.now() - startedAt;
      const groups = result.data ?? {};
      const count = ['web', 'news', 'images']
        .reduce((total, key) => total + (Array.isArray(groups[key]) ? groups[key].length : 0), 0);
      const tiers = Array.isArray(result.tiers_tried) ? result.tiers_tried.join(' -> ') : 'unknown';
      add('search', count > 0, count > 0 ? `${count} results in ${elapsed} ms via ${tiers}` : `no results via ${tiers}`);
    } catch (error) {
      add('search', false, error.message);
    }
  }

  return { ok: rows.every((row) => row.ok || !row.fatal), rows };
}
