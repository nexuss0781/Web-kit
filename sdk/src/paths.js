/**
 * Where the SDK keeps everything it owns.
 *
 * One directory, `~/.webkit`, so that "remove Web-Kit" is one delete and so
 * that a failure can be reported as a path the user can open. `WEBKIT_HOME`
 * moves it, which is what a test or a CI job uses.
 *
 * Nothing here is inside the npm package: the package is immutable after
 * install, and SearXNG is downloaded, so it cannot live there anyway.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const home = process.env.WEBKIT_HOME
  ? path.resolve(process.env.WEBKIT_HOME)
  : path.join(os.homedir(), '.webkit');

export const paths = {
  home,
  config: path.join(home, 'config.json'),
  daemon: path.join(home, 'daemon.json'),
  daemonLog: path.join(home, 'daemon.log'),

  searxng: path.join(home, 'searxng'),
  searxngVenv: path.join(home, 'searxng-venv'),
  searxngSettings: path.join(home, 'searxng.yml'),
  searxngLog: path.join(home, 'searxng.log'),
  limiters: path.join(home, 'limiter.toml'),

  /** Modules SearXNG needs but Windows does not ship; see python/pwd.py. */
  pythonCompat: path.join(home, 'python-compat'),

  cache: path.join(home, 'cache'),
};

export function ensureDirs() {
  for (const dir of [home, paths.cache, paths.pythonCompat]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** The interpreter inside a virtual environment, which differs by platform. */
export function venvPython(venv = paths.searxngVenv) {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

/** The last n lines of a log, for the error message a failure deserves. */
export function tail(file, lines = 20) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
