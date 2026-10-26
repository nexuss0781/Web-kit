/**
 * SearXNG: fetched, installed, configured and supervised by the SDK.
 *
 * This is the primary provider, so it has to work on a machine that has only
 * Python and no Docker -- which is the machine this was built on. Three things
 * make that possible:
 *
 * 1. **A tarball, not a clone.** The repository contains a filename with a
 *    colon, which Windows cannot store, so git cannot check it out. We fetch
 *    `codeload` bytes and extract only `searx/` and the requirement files.
 * 2. **A virtual environment next to it.** Nothing is installed into the
 *    user's Python, and removing `~/.webkit` removes all of it.
 * 3. **A shim for one POSIX module.** `searx/valkeydb.py` imports `pwd` at
 *    module scope. The limiter is off and no Valkey URL is configured, so the
 *    function is never called; see `python/pwd.py`.
 *
 * Configuration uses SearXNG's own `use_default_settings`, so an upgrade of
 * the source does not need an upgrade of a hand-maintained 85 KB settings file:
 * we write the dozen keys that matter and let SearXNG supply the rest.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, venvPython, tail, sleep, ensureDirs } from './paths.js';
import { run, runOrThrow } from './run.js';
import { nextFreePort } from './net.js';
import { readSettings, writeSettings as writeSettingsFile, randomSecret } from './settings.js';

const SEARXNG_REPO = 'https://github.com/searxng/searxng';
const DEFAULT_REF = 'master';
const MARKER = '.webkit-deps';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The entries a running instance needs; everything else in the tarball is build machinery. */
function wanted(name) {
  if (name.includes('__pycache__')) return false;
  if (/^requirements(-server)?\.txt$/.test(name)) return true;
  return name.startsWith('searx/');
}

export function ref() {
  return process.env.WEBKIT_SEARXNG_REF || DEFAULT_REF;
}

export function state() {
  return {
    source: fs.existsSync(path.join(paths.searxng, 'searx', 'webapp.py')),
    venv: fs.existsSync(venvPython()),
    deps: fs.existsSync(path.join(paths.searxngVenv, MARKER)),
    settings: fs.existsSync(paths.searxngSettings),
  };
}

export function installed() {
  const current = state();
  return current.source && current.venv && current.deps;
}

/**
 * Find a Python that can build a working environment.
 *
 * `py -3` first on Windows: it is the launcher python.org installs, and it
 * respects the user's PATH choices. The explicit candidates after it are for
 * machines (and CI images) that only put one of them on PATH.
 */
export async function findPython() {
  const candidates = [];
  if (process.env.WEBKIT_PYTHON) candidates.push({ command: process.env.WEBKIT_PYTHON, prefix: [] });
  if (process.platform === 'win32') {
    candidates.push({ command: 'py', prefix: ['-3'] });
    candidates.push({ command: 'python', prefix: [] });
    candidates.push({ command: 'python3', prefix: [] });
  } else {
    candidates.push({ command: 'python3', prefix: [] });
    candidates.push({ command: 'python', prefix: [] });
  }

  const tried = [];
  for (const candidate of candidates) {
    try {
      const result = await run(candidate.command, [
        ...candidate.prefix,
        '-c',
        'import sys;print("%d.%d" % sys.version_info[:2]);print(sys.executable)',
      ], { timeoutMs: 20_000 });
      if (result.code !== 0) {
        tried.push(`${candidate.command}: exit ${result.code}`);
        continue;
      }
      const [version, executable] = result.stdout.trim().split(/\r?\n/);
      const [major, minor] = String(version).split('.').map(Number);
      if (major < 3 || (major === 3 && minor < 10)) {
        tried.push(`${candidate.command}: Python ${version} is too old`);
        continue;
      }
      return { ...candidate, version, executable };
    } catch (error) {
      tried.push(`${candidate.command}: ${error.message}`);
    }
  }

  throw new Error(
    'SearXNG needs Python 3.10 or newer, and none was found.\n'
    + `Tried: ${tried.join('; ')}\n`
    + 'Install Python from python.org, or point WEBKIT_PYTHON at an interpreter.',
  );
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`downloading SearXNG failed: HTTP ${response.status} from ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1_000_000) {
    throw new Error(`downloading SearXNG returned only ${bytes.length} bytes; the mirror may be broken`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { bytes: bytes.length, archive: bytes };
}

async function ensureSource({ force = false, log = () => {} } = {}) {
  if (!force && state().source) {
    // Record where it came from even when it was placed there by hand, so
    // `doctor` can say something more useful than "unknown".
    const meta = path.join(paths.searxng, 'webkit-source.json');
    if (!fs.existsSync(meta)) {
      try {
        const stat = fs.statSync(path.join(paths.searxng, 'searx', 'webapp.py'));
        fs.writeFileSync(meta, `${JSON.stringify({
          ref: 'pre-existing',
          repo: SEARXNG_REPO,
          fetchedAt: stat.mtime.toISOString(),
        }, null, 2)}\n`);
      } catch {
        // Metadata is a nicety; failing to write it must not fail the install.
      }
    }
    return { fetched: false };
  }

  const tag = ref().replace(/[^A-Za-z0-9._-]/g, '-');
  const cached = path.join(paths.cache, `searxng-${tag}.tar.gz`);
  let archive;
  let bytes;

  if (!force && fs.existsSync(cached) && fs.statSync(cached).size > 1_000_000) {
    archive = fs.readFileSync(cached);
    bytes = archive.length;
    log(`using cached source (${(bytes / 1e6).toFixed(1)} MB)`);
  } else {
    const url = `https://codeload.github.com/searxng/searxng/tar.gz/refs/heads/${ref()}`;
    log(`downloading ${url}`);
    const result = await download(url, cached);
    archive = result.archive;
    bytes = result.bytes;
  }

  const { extractTarGz } = await import('./tar.js');
  const staging = `${paths.searxng}.new`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const result = extractTarGz(archive, staging, { filter: wanted, strip: 1 });
  if (!fs.existsSync(path.join(staging, 'searx', 'webapp.py'))) {
    throw new Error('the downloaded archive did not contain searx/webapp.py');
  }

  fs.rmSync(paths.searxng, { recursive: true, force: true });
  try {
    fs.renameSync(staging, paths.searxng);
  } catch (error) {
    // A virus scanner or an open file can hold the directory for a moment.
    await sleep(500);
    fs.rmSync(staging, { recursive: true, force: true });
    if (!state().source) throw error;
  }

  const meta = { ref: ref(), repo: SEARXNG_REPO, fetchedAt: new Date().toISOString(), files: result.files, bytes };
  fs.writeFileSync(path.join(paths.searxng, 'webkit-source.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { fetched: true, ...result };
}

function requirementsFile() {
  return path.join(paths.searxng, 'requirements.txt');
}

function depsHash() {
  try {
    const content = fs.readFileSync(requirementsFile(), 'utf8');
    // tzdata is installed alongside the requirements, so a change to either
    // means the environment has to be built again.
    return createHash('sha256').update(`${content}\ntzdata\n`).digest('hex').slice(0, 16);
  } catch {
    return 'unknown';
  }
}

/**
 * Install the source, the interpreter and the dependencies.
 *
 * Idempotent: each step is skipped when its result is already on disk, so
 * calling this on every `start` costs a few `existsSync` calls after the first.
 */
export async function provision({ force = false, log = () => {} } = {}) {
  ensureDirs();

  if (force) fs.rmSync(paths.searxngVenv, { recursive: true, force: true });

  log('checking Python');
  const python = await findPython();
  log(`using Python ${python.version} (${python.executable})`);

  log(state().source && !force ? 'source already present' : 'installing SearXNG source');
  await ensureSource({ force, log });

  const py = venvPython();
  if (!fs.existsSync(py)) {
    log(`creating a virtual environment at ${paths.searxngVenv}`);
    await runOrThrow(python.command, [...python.prefix, '-m', 'venv', paths.searxngVenv], { timeoutMs: 300_000 });
  }

  const marker = path.join(paths.searxngVenv, MARKER);
  const desired = depsHash();
  let current = '';
  try { current = fs.readFileSync(marker, 'utf8').trim(); } catch { /* not installed */ }

  if (current !== desired) {
    log('installing dependencies (a few minutes on the first run)');
    await runOrThrow(py, [
      '-m', 'pip', 'install',
      '--disable-pip-version-check',
      '--no-input',
      '--progress-bar', 'off',
      '-r', requirementsFile(),
      // Windows ships no IANA time zone database, which several engines use.
      'tzdata',
    ], { timeoutMs: 1_800_000 });
    fs.writeFileSync(marker, desired);
  } else {
    log('dependencies already installed');
  }

  installCompat();
  writeSettings(readSettings());

  const version = await run(py, ['-c', 'import searx, flask, curl_cffi, tzdata; print("ok")'], {
    cwd: paths.searxng,
    timeoutMs: 120_000,
  });
  if (version.code !== 0) {
    throw new Error(`SearXNG is installed but does not import:\n${version.stderr.trim()}`);
  }

  return { python: python.version, path: paths.searxng };
}

/**
 * The two files SearXNG expects a POSIX host to provide.
 *
 * `pwd` is a module; `limiter.toml` is read from the directory holding the
 * settings file even when the limiter is disabled, and its absence is a warning
 * on every boot. Copying the shipped one silences that honestly.
 */
function installCompat() {
  const shim = path.join(here, '..', 'python', 'pwd.py');
  if (fs.existsSync(shim)) {
    fs.mkdirSync(paths.pythonCompat, { recursive: true });
    fs.copyFileSync(shim, path.join(paths.pythonCompat, 'pwd.py'));
  }

  const limiter = path.join(paths.searxng, 'searx', 'limiter.toml');
  if (fs.existsSync(limiter)) fs.copyFileSync(limiter, paths.limiters);
}

/**
 * The settings file, which is deliberately short.
 *
 * `use_default_settings: true` makes SearXNG merge this onto its shipped
 * defaults, so an engine added upstream appears without us editing anything.
 * The keys here are only the ones a local, private instance must change.
 */
export function writeSettings(settings) {
  ensureDirs();

  let secret = null;
  try {
    secret = JSON.parse(fs.readFileSync(paths.config, 'utf8')).searxngSecret ?? null;
  } catch {
    // first run
  }
  if (!secret) {
    secret = randomSecret();
    writeSettingsFile({ searxngSecret: secret });
  }

  const yaml = [
    '# Generated by Web-Kit. Rewritten on every start; edit ~/.webkit/config.json instead.',
    'use_default_settings: true',
    'general:',
    '  instance_name: "Web-Kit"',
    '  donation_url: false',
    '  contact_url: false',
    '  enable_metrics: false',
    'search:',
    '  safe_search: 0',
    '  autocomplete: ""',
    '  formats:',
    '    - html',
    '    - json',
    'server:',
    `  port: ${settings.searxngPort}`,
    '  bind_address: "127.0.0.1"',
    `  secret_key: "${secret}"`,
    '  limiter: false',
    '  public_instance: false',
    '  image_proxy: false',
    '  method: "GET"',
    '  http_protocol_version: "1.0"',
    '',
  ].join('\n');

  fs.writeFileSync(paths.searxngSettings, yaml, { mode: 0o600 });
  return { path: paths.searxngSettings, port: settings.searxngPort, secret };
}

/** Is this port a SearXNG that will answer? */
export async function healthy(port = readSettings().searxngPort, timeoutMs = 1200) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

let child = null;
let runningPort = null;
let shuttingDown = false;

export function running() {
  return child ? runningPort : null;
}

/**
 * Start a supervised instance, reusing one that already answers.
 *
 * `reused` matters to the caller: a second `webkit start` must not spawn a
 * second Python process, and the daemon must point at whichever port is real.
 */
export async function start(settings, { log = () => {} } = {}) {
  if (await healthy(settings.searxngPort)) {
    runningPort = settings.searxngPort;
    return { port: settings.searxngPort, reused: true };
  }
  if (!installed()) throw new Error('SearXNG is not installed yet; run `webkit setup`');

  const port = await nextFreePort(settings.searxngPort);
  if (port !== settings.searxngPort) {
    log(`port ${settings.searxngPort} is in use; SearXNG will listen on ${port}`);
  }

  writeSettings({ ...settings, searxngPort: port });

  const env = {
    ...process.env,
    SEARXNG_SETTINGS_PATH: paths.searxngSettings,
    PYTHONPATH: [paths.pythonCompat, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  delete env.PYTHONHOME;

  const logFd = fs.openSync(paths.searxngLog, 'a');
  child = spawn(venvPython(), ['-m', 'searx.webapp'], {
    cwd: paths.searxng,
    env,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.once('exit', (code) => {
    logFdSafe(logFd);
    if (!shuttingDown) log(`SearXNG exited with code ${code}`);
    child = null;
    runningPort = null;
  });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await healthy(port, 1000)) {
      runningPort = port;
      return { port, reused: false };
    }
    if (!child) break;
    await sleep(400);
  }

  await stop();
  const detail = tail(paths.searxngLog, 25);
  throw new Error(
    `SearXNG did not answer on port ${port}${detail ? `\n\n${detail}` : ''}\n\nRun \`webkit doctor\` for a full report.`,
  );
}

function logFdSafe(fd) {
  try { fs.closeSync(fd); } catch { /* already closed */ }
}

export async function stop() {
  if (!child) {
    runningPort = null;
    return false;
  }
  shuttingDown = true;
  const pid = child.pid;
  child.kill();
  const deadline = Date.now() + 8000;
  while (child && Date.now() < deadline) await sleep(150);
  if (child && process.platform === 'win32') {
    // A Python process that ignores a polite kill is not going to start
    // listening to reason; the tree owns nothing else we need.
    await run('taskkill', ['/pid', String(pid), '/T', '/F'], { timeoutMs: 10_000 });
  }
  child = null;
  runningPort = null;
  shuttingDown = false;
  return true;
}
