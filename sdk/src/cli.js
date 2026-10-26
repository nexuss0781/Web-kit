/**
 * The command line.
 *
 * Two jobs: make the first run one command, and make every later run obvious.
 * One-shot commands use the daemon when it is up and the engine in-process when
 * it is not, so `webkit search` never fails merely because nothing is running.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings, connectEnv } from './settings.js';
import { paths } from './paths.js';
import { provision, installed, healthy as searxngHealthy } from './searxng.js';
import { start as startDaemon, stop as stopDaemon, serve, readDaemon, isRunning } from './daemon.js';
import { createClient } from './client.js';
import { doctor } from './doctor.js';
import { fetchJson } from './net.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const VALUE_FLAGS = new Set([
  'limit', 'sources', 'out', 'port', 'searxng-port', 'tbs', 'time', 'site', 'lang', 'format',
]);

/**
 * Flags that have a one-dash spelling, because every other search tool has one.
 * `-o` matters most: it is what the Firecrawl CLI documents for "write the page
 * to this file", and a user typing it must not get the page on stdout instead.
 */
const SHORT_FLAGS = new Map([
  ['-o', 'out'],
  ['-l', 'limit'],
]);

export function parseFlags(argv) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (SHORT_FLAGS.has(token)) {
      const name = SHORT_FLAGS.get(token);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[name] = next;
        index += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (VALUE_FLAGS.has(body) && index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
      flags[body] = argv[index + 1];
      index += 1;
    } else {
      flags[body] = true;
    }
  }
  return { flags, positionals };
}

function version() {
  return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
}

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function info(message) {
  process.stderr.write(`webkit: ${message}\n`);
}

function settingsWith(flags) {
  const settings = readSettings();
  if (flags.port) settings.port = Number.parseInt(flags.port, 10);
  if (flags['searxng-port']) settings.searxngPort = Number.parseInt(flags['searxng-port'], 10);
  if (flags['no-searxng']) settings.searxng = false;
  return settings;
}

/** The client for a one-shot command, starting the daemon when that is allowed. */
async function connected(settings, flags) {
  // A live instance on the configured port is usable even when this home
  // directory has no copy of the source, so only warn when both are missing.
  if (settings.searxng && !installed() && !(await searxngHealthy(settings.searxngPort))) {
    info('SearXNG is not installed yet, so this query uses the free index and the verticals. Run `webkit setup` for the full index.');
  }
  const shouldStart = !flags['no-start'] && settings.autoStart;
  if (shouldStart && !(await isRunning())) {
    try {
      await startDaemon(settings, { log: info });
    } catch (error) {
      info(`the local engine did not start (${error.message.split('\n')[0]}); answering in this process instead`);
    }
  }
  return createClient({ settings });
}

function printGroups(result) {
  const data = result.data ?? {};

  for (const answer of data.answers ?? []) {
    out(`= ${answer.answer}${answer.url ? `\n  ${answer.url}` : ''}`);
  }

  let position = 1;
  for (const key of ['web', 'news', 'images']) {
    const rows = Array.isArray(data[key]) ? data[key] : [];
    if (!rows.length) continue;
    if (key !== 'web') out(`\n${key}:`);
    for (const row of rows) {
      out(`\n${String(position).padStart(2)}. ${row.title || row.url}`);
      out(`    ${row.url}`);
      if (row.description) out(`    ${row.description.replace(/\s+/g, ' ').slice(0, 300)}`);
      if (key === 'images' && row.imageUrl) out(`    image: ${row.imageUrl}`);
      position += 1;
    }
  }

  if (position === 1) out('no results');

  if (Array.isArray(result.warnings) && result.warnings.length) {
    info(`partial: ${result.warnings.join('; ')}`);
  }
}

async function commandSearch(rest) {
  const { flags, positionals } = parseFlags(rest);
  const query = positionals.join(' ').trim();
  if (!query) throw new Error('usage: webkit search <query> [--limit 10] [--news] [--images] [--site domain] [--json]');

  const settings = settingsWith(flags);
  const body = { query, limit: Number.parseInt(flags.limit ?? '10', 10) };

  if (flags.news) body.sources = ['news'];
  if (flags.images) body.sources = ['images'];
  if (flags.sources) body.sources = String(flags.sources).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (flags.site) body.includeDomains = String(flags.site).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (flags.tbs) body.tbs = flags.tbs;
  if (flags.time) body.tbs = `qdr:${String(flags.time)[0]}`;
  if (flags.lang) body.language = flags.lang;

  const client = await connected(settings, flags);
  try {
    const result = await client.search(body);
    if (flags.json) out(JSON.stringify(result, null, 2));
    else printGroups(result);
    return result;
  } finally {
    await client.close();
  }
}

async function commandScrape(rest) {
  const { flags, positionals } = parseFlags(rest);
  const url = positionals[0];
  if (!url) throw new Error('usage: webkit scrape <url> [--html] [--json] [-o file]');
  if (flags.out === true) throw new Error('-o needs a file name, for example: webkit scrape <url> -o page.md');

  const settings = settingsWith(flags);
  const formats = flags.html || flags.raw ? ['html', 'markdown'] : ['markdown'];

  const client = await connected(settings, flags);
  try {
    const result = await client.scrape({ url, formats });
    const data = result.data ?? {};
    const text = flags.json
      ? JSON.stringify(result, null, 2)
      : (flags.raw ? (data.rawHtml ?? data.html ?? data.markdown) : data.markdown) ?? '';

    if (flags.out) {
      fs.mkdirSync(path.dirname(path.resolve(String(flags.out))), { recursive: true });
      fs.writeFileSync(String(flags.out), text);
      info(`wrote ${String(flags.out)} (${text.length} bytes)`);
    } else {
      out(text);
    }
    return result;
  } finally {
    await client.close();
  }
}

async function commandStart(rest) {
  const { flags } = parseFlags(rest);
  const settings = settingsWith(flags);

  if (settings.searxng && !installed()) {
    info('SearXNG is not installed yet, so it is being installed now. This happens once.');
    await provision({ force: Boolean(flags.force), log: (line) => info(line) });
  }

  const record = await startDaemon(settings, { log: (line) => info(line) });
  const ready = await fetchJson(`${record.url}/readyz`, { timeoutMs: 5000 }).catch(() => null);

  out(`Web-Kit is running at ${record.url}`);
  out(`  pid       ${record.pid}`);
  out(`  searxng   ${record.searxngPort ? `http://127.0.0.1:${record.searxngPort}` : 'off'}`);
  if (ready?.body) {
    out(`  providers ${ready.body.providers}`);
    out(`  keyless   ${ready.body.keyless_firecrawl ? 'available' : 'off or superseded by a key'}`);
  }
  out('');
  out('Connect a shell:');
  for (const [key, value] of Object.entries(connectEnv({ ...settings, port: record.port }))) out(`  set ${key}=${value}`);
}

async function commandStatus() {
  const record = readDaemon();
  const up = await isRunning(record);
  out(`Web-Kit ${version()}`);
  out(`  home      ${paths.home}`);

  if (!up) {
    out('  engine    not running (webkit start)');
    const settings = readSettings();
    out(`  searxng   ${await searxngHealthy(settings.searxngPort) ? `http://127.0.0.1:${settings.searxngPort}` : 'not running'}`);
    return;
  }

  const ready = await fetchJson(`${record.url}/readyz`, { timeoutMs: 4000 }).catch(() => null);
  const started = record.startedAt ? Math.round((Date.now() - Date.parse(record.startedAt)) / 1000) : null;
  out(`  engine    ${record.url} (pid ${record.pid}${started !== null ? `, up ${started}s` : ''})`);
  out(`  searxng   ${record.searxngPort ? `http://127.0.0.1:${record.searxngPort}` : 'off'}`);
  if (ready?.body) {
    out(`  providers ${ready.body.providers}`);
    out(`  keyless   ${ready.body.keyless_firecrawl ? 'available' : 'off or superseded by a key'}`);
  }
}

async function commandDoctor(rest) {
  const { flags } = parseFlags(rest);
  const report = await doctor({ probe: !flags.fast, settings: settingsWith(flags) });
  out(`Web-Kit doctor (${version()})`);
  out('');
  for (const row of report.rows) {
    const mark = row.ok ? 'ok' : (row.fatal ? '!!' : '--');
    out(`  [${mark}] ${row.name.padEnd(20)} ${row.detail.split('\n')[0] ?? ''}`);
    if (!row.ok) {
      for (const line of row.detail.split('\n').slice(1)) out(`         ${line}`);
    }
  }
  out('');
  out(report.ok ? 'ready: a search will use the tiers listed above.' : 'not ready: fix the items marked !! first.');
  if (!report.ok) process.exitCode = 1;
}

async function commandSetup(rest) {
  const { flags } = parseFlags(rest);
  const settings = settingsWith(flags);

  out(`Installing SearXNG into ${paths.searxng}`);
  await provision({ force: Boolean(flags.force), log: (line) => out(`  ${line}`) });
  out('');
  out('Installed. Start it with:');
  out('  webkit start');
  out('');
  out(`Configured port: ${settings.searxngPort} (change with --searxng-port or ~/.webkit/config.json)`);
}

async function commandEnv(rest) {
  const { flags } = parseFlags(rest);
  let settings = settingsWith(flags);

  // A daemon may have moved off the configured port because it was taken.
  // Printing the configured port would hand the caller a dead address.
  const record = readDaemon();
  if (!flags.port && record && await isRunning(record)) {
    settings = { ...settings, port: record.port };
  }

  const env = connectEnv(settings);

  if (flags.json) {
    out(JSON.stringify(env, null, 2));
    return;
  }
  const shell = flags.sh || (process.platform !== 'win32' && !flags.cmd);
  for (const [key, value] of Object.entries(env)) out(`${shell ? 'export' : 'set'} ${key}=${value}`);
}

function commandSkill() {
  const file = path.join(here, '..', 'skills', 'webkit', 'SKILL.md');
  if (!fs.existsSync(file)) throw new Error('the skill file is missing from this install');
  out(file);
}

function commandHelp() {
  out(`Web-Kit ${version()} - self-hosted web access for agents

Usage:
  webkit setup [--force]             install SearXNG into ~/.webkit (once)
  webkit start [--no-searxng]        start the background engine
  webkit stop                        stop it
  webkit status                      what is running, and where
  webkit doctor [--fast]             check every dependency and probe a search
  webkit serve [--no-searxng]        run the engine in this terminal

  webkit search <query> [options]    search the web
  webkit scrape <url> [options]      read one page
  webkit env [--sh|--json]           variables that point the Firecrawl CLI here
  webkit skill                       print the path of the agent skill

Search options:
  --limit N        results to ask for (default 10)
  --news           ask the news index
  --images         ask the image index
  --sources a,b    web, news, images
  --site domain    restrict to a domain (comma separated)
  --tbs qdr:w      freshness: qdr:h day, qdr:w week, qdr:m month, qdr:y year
  --time week      same, named
  --lang en        language hint
  --json           print the Firecrawl-shaped envelope
  --no-start       do not start the daemon for this command

Scrape options:
  --html           also return HTML
  --raw            print the raw HTML instead of markdown
  -o file          write the page to a file

Everything is stored in ${paths.home}; delete that directory to uninstall.`);
}

export async function main(argv) {
  const [command = 'help', ...rest] = argv;

  switch (command) {
    case 'setup': await commandSetup(rest); break;
    case 'start': await commandStart(rest); break;
    case 'stop': {
      const stopped = await stopDaemon();
      out(stopped ? 'stopped' : 'not running');
      break;
    }
    case 'status': await commandStatus(); break;
    case 'doctor': await commandDoctor(rest); break;
    case 'serve': await serve(settingsWith(parseFlags(rest).flags), { log: info }); break;
    case 'search': await commandSearch(rest); break;
    case 'scrape': await commandScrape(rest); break;
    case 'env': await commandEnv(rest); break;
    case 'skill': commandSkill(); break;
    case 'version': case '--version': case '-v': out(version()); break;
    case 'help': case '--help': case '-h': commandHelp(); break;
    default:
      throw new Error(`unknown command '${command}'. Run \`webkit help\`.`);
  }
}
