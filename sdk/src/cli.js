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
import { readSettings, writeSettings, connectEnv } from './settings.js';
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

function splitList(value) {
  return String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function numberOf(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * Waits for an asynchronous job.
 *
 * The engine answers a start with an id because a crawl can take minutes, and
 * holding a request open for that long would time out somewhere in between. A
 * shell command can afford to wait, so this is the one place that turns the
 * start/status pair back into a single answer.
 */
async function waitForJob(fetchStatus, { label = 'job', timeoutMs = 10 * 60 * 1000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await fetchStatus();
    if (TERMINAL.has(status.status)) return status;
    if (Date.now() >= deadline) {
      throw new Error(`the ${label} is still ${status.status}; poll /v2/${label}/${status.id ?? ''} or raise the timeout`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function printDocuments(status) {
  const documents = Array.isArray(status.data) ? status.data : [];
  for (const document of documents) {
    const metadata = document.metadata ?? {};
    out(`${metadata.sourceURL ?? metadata.url ?? '(unknown)'}`);
    if (metadata.title) out(`  ${metadata.title}`);
  }
  out(`\n${documents.length} of ${status.total ?? documents.length} pages, ${status.status}`);
  if (status.warning) info(`warning: ${status.warning}`);
}

async function commandMap(rest) {
  const { flags, positionals } = parseFlags(rest);
  const url = positionals[0];
  if (!url) throw new Error('usage: webkit map <url> [--limit 5000] [--search term] [--json]');

  const body = { url, limit: numberOf(flags.limit, 5_000) };
  if (flags.search) body.search = String(flags.search);
  if (flags.sitemap) body.sitemap = String(flags.sitemap);

  const client = await connected(settingsWith(flags), flags);
  try {
    const result = await client.map(body);
    if (flags.json) {
      out(JSON.stringify(result, null, 2));
    } else {
      for (const link of result.links ?? []) out(link.url);
      out(`\n${(result.links ?? []).length} URLs`);
      if (result.warning) info(`warning: ${result.warning}`);
    }
    return result;
  } finally {
    await client.close();
  }
}

async function commandCrawl(rest) {
  const { flags, positionals } = parseFlags(rest);
  const url = positionals[0];
  if (!url) throw new Error('usage: webkit crawl <url> [--limit 20] [--paths a,b] [--exclude c,d] [--depth N] [--no-wait] [--json]');

  const body = { url, limit: numberOf(flags.limit, 20) };
  if (flags.paths) body.includePaths = splitList(flags.paths);
  if (flags.exclude) body.excludePaths = splitList(flags.exclude);
  if (flags.depth) body.maxDiscoveryDepth = numberOf(flags.depth, 3);
  if (flags.concurrency) body.maxConcurrency = numberOf(flags.concurrency, 4);
  if (flags.sitemap) body.sitemap = String(flags.sitemap);

  const client = await connected(settingsWith(flags), flags);
  try {
    const started = await client.crawl(body);
    if (flags['no-wait']) {
      out(flags.json ? JSON.stringify(started, null, 2) : `crawl ${started.id}\n  ${started.url ?? ''}`);
      return started;
    }
    const status = await waitForJob(() => client.crawlStatus(started.id), { label: 'crawl' });
    if (flags.json) out(JSON.stringify(status, null, 2));
    else printDocuments(status);
    if (status.error) throw new Error(status.error);
    return status;
  } finally {
    await client.close();
  }
}

async function commandBatch(rest) {
  const { flags, positionals } = parseFlags(rest);
  const urls = flags.urls ? splitList(flags.urls) : positionals;
  if (!urls.length) throw new Error('usage: webkit batch <url...> [--no-wait] [--json]');

  const client = await connected(settingsWith(flags), flags);
  try {
    const started = await client.batch({ urls });
    if (flags['no-wait']) {
      out(flags.json ? JSON.stringify(started, null, 2) : `batch ${started.id}\n  ${started.url ?? ''}`);
      return started;
    }
    const status = await waitForJob(() => client.batchStatus(started.id), { label: 'batch' });
    if (flags.json) out(JSON.stringify(status, null, 2));
    else printDocuments(status);
    if (status.error) throw new Error(status.error);
    return status;
  } finally {
    await client.close();
  }
}

/** A schema is either inline JSON or a path to a file that holds it. */
function readSchema(value) {
  const source = String(value ?? '').trim();
  if (!source) return undefined;
  if (source.startsWith('{') || source.startsWith('[')) return JSON.parse(source);
  return JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'));
}

async function commandExtract(rest) {
  const { flags, positionals } = parseFlags(rest);
  if (!positionals.length) throw new Error('usage: webkit extract <url...> [--schema file.json] [--prompt text] [--no-wait] [--json]');

  const body = { urls: positionals };
  if (flags.schema) body.schema = readSchema(flags.schema);
  if (flags.prompt) body.prompt = String(flags.prompt);

  const client = await connected(settingsWith(flags), flags);
  try {
    const started = await client.extract(body);
    if (flags['no-wait']) {
      out(flags.json ? JSON.stringify(started, null, 2) : `extract ${started.id}\n  ${started.url ?? ''}`);
      return started;
    }
    const status = await waitForJob(() => client.extractStatus(started.id), { label: 'extract' });
    if (flags.json) {
      out(JSON.stringify(status, null, 2));
    } else {
      out(JSON.stringify(status.data ?? {}, null, 2));
      if (status.model) info(`model: ${status.model}`);
    }
    if (status.error) throw new Error(status.error);
    return status;
  } finally {
    await client.close();
  }
}

async function commandMonitor(rest) {
  const { flags, positionals } = parseFlags(rest);
  const [action = 'list', ...args] = positionals;

  const client = await connected(settingsWith(flags), flags);
  try {
    if (action === 'list') {
      const result = await client.monitors();
      if (flags.json) {
        out(JSON.stringify(result, null, 2));
      } else {
        for (const monitor of result.data ?? []) {
          out(`${monitor.id}  ${monitor.status.padEnd(6)}  ${monitor.name}`);
          out(`  ${monitor.schedule.cron} (${monitor.schedule.timezone}), next ${monitor.nextRunAt ?? 'unknown'}`);
        }
        if (!(result.data ?? []).length) out('no monitors');
      }
      return result;
    }

    if (action === 'create') {
      const name = String(flags.name ?? '').trim();
      if (!name) throw new Error('usage: webkit monitor create --name "..." (--every "15 minutes" | --cron "*/15 * * * *") (--urls a,b | --crawl URL | --queries "a,b" --goal "...")');
      const schedule = flags.cron ? { cron: String(flags.cron) } : { text: String(flags.every ?? 'every 30 minutes') };
      const targets = [];
      if (flags.urls) targets.push({ type: 'scrape', urls: splitList(flags.urls) });
      if (flags.crawl) targets.push({ type: 'crawl', url: String(flags.crawl), crawlOptions: { limit: numberOf(flags.limit, 10) } });
      if (flags.queries) targets.push({ type: 'search', queries: splitList(flags.queries), maxResults: numberOf(flags.results, 10) });
      if (!targets.length) throw new Error('a monitor needs at least one target: --urls, --crawl or --queries');

      const body = { name, schedule, targets };
      if (flags.goal) body.goal = String(flags.goal);
      const result = await client.createMonitor(body);
      out(flags.json ? JSON.stringify(result, null, 2) : `${result.data.id}  ${result.data.name}\n  ${result.data.schedule.cron}, next ${result.data.nextRunAt}`);
      return result;
    }

    if (action === 'get') {
      const result = await client.getMonitor(args[0]);
      out(JSON.stringify(result.data, null, 2));
      return result;
    }

    if (action === 'run') {
      const result = await client.runMonitor(args[0]);
      const check = result.data;
      out(flags.json ? JSON.stringify(result, null, 2) : `${check?.id ?? 'check'}  ${check?.status ?? 'unknown'}  ${JSON.stringify(check?.summary ?? {})}`);
      return result;
    }

    if (action === 'checks') {
      const result = await client.monitorChecks(args[0]);
      if (flags.json) {
        out(JSON.stringify(result, null, 2));
      } else {
        for (const check of result.data ?? []) out(`${check.id}  ${check.status}  ${check.startedAt}  ${JSON.stringify(check.summary)}`);
        if (!(result.data ?? []).length) out('no checks yet');
      }
      return result;
    }

    if (action === 'check') {
      const result = await client.monitorCheck(args[0], args[1]);
      out(JSON.stringify(result.data, null, 2));
      return result;
    }

    if (action === 'delete' || action === 'remove') {
      const result = await client.deleteMonitor(args[0]);
      out('deleted');
      return result;
    }

    if (action === 'pause' || action === 'resume') {
      const result = await client.updateMonitor(args[0], { status: action === 'pause' ? 'paused' : 'active' });
      out(`${result.data.id}  ${result.data.status}`);
      return result;
    }

    throw new Error(`unknown monitor action '${action}'. Use list, create, get, run, checks, check, pause, resume or delete.`);
  } finally {
    await client.close();
  }
}

async function commandStart(rest) {  const { flags } = parseFlags(rest);
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

/**
 * Settings that can be stored in `~/.webkit/config.json`.
 *
 * Only secrets and values a user changes once. A per-command override belongs
 * on the command's own flags, not in a file that outlives the command.
 */
const CONFIG_KEYS = new Map([
  ['github-token', 'githubToken'],
  ['githubToken', 'githubToken'],
]);

/**
 * `webkit config`: what is stored, and how to change the one secret that is
 * worth storing.
 *
 * A value written here is never echoed back. Not because the file is readable
 * -- it is the user's own file -- but because a terminal scrollback and a
 * pasted bug report are how credentials escape. The listing says whether a
 * value is set, which is the only question it is asked.
 */
function commandConfig(rest) {
  const [action = 'list', rawKey, ...value] = rest;

  if (action === 'list' || action === 'show' || action === 'get') {
    const settings = readSettings();
    out(`home      ${paths.home}`);
    out(`port      ${settings.port}`);
    out(`searxng   ${settings.searxng ? `on (port ${settings.searxngPort})` : 'off'}`);
    out(`token     ${settings.token ? 'set' : 'not set'}`);
    out(`github    ${settings.githubToken ? 'set' : 'not set'}`);
    return;
  }

  if (action !== 'set' && action !== 'unset') {
    throw new Error(`unknown config action '${action}'. Use \`webkit config list\` or \`webkit config set github-token <token>\`.`);
  }
  if (!rawKey) throw new Error(`usage: webkit config ${action} github-token${action === 'set' ? ' <token>' : ''}`);

  const key = CONFIG_KEYS.get(rawKey);
  if (!key) {
    throw new Error(`unknown setting '${rawKey}'. Settable settings: ${[...new Set(CONFIG_KEYS.keys())].join(', ')}`);
  }

  if (action === 'unset') {
    writeSettings({ [key]: null });
    out(`${rawKey} cleared`);
    return;
  }

  const token = value.join(' ').trim();
  if (!token) throw new Error('usage: webkit config set github-token <token>');
  writeSettings({ [key]: token });
  // The value is deliberately absent from this line and from every later one.
  out(`${rawKey} stored in ${paths.config}`);
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
  webkit map <url> [options]         discover links on a site
  webkit crawl <url> [options]       crawl a site and collect pages
  webkit batch <url...> [options]    scrape a list of pages
  webkit extract <url...> [options] extract structured data from pages
  webkit monitor <action> [...]     watch pages for changes
  webkit env [--sh|--json]           variables that point the Firecrawl CLI here
  webkit config [list]               stored settings, secrets reported as set or not
  webkit config set github-token X   store a GitHub token for the developer index
  webkit config unset github-token   forget it
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
    case 'map': await commandMap(rest); break;
    case 'crawl': await commandCrawl(rest); break;
    case 'batch': await commandBatch(rest); break;
    case 'extract': await commandExtract(rest); break;
    case 'monitor': await commandMonitor(rest); break;
    case 'env': await commandEnv(rest); break;
    case 'config': commandConfig(rest); break;
    case 'skill': commandSkill(); break;
    case 'version': case '--version': case '-v': out(version()); break;
    case 'help': case '--help': case '-h': commandHelp(); break;
    default:
      throw new Error(`unknown command '${command}'. Run \`webkit help\`.`);
  }
}
