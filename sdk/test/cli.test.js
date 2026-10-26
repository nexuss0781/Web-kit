import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'webkit.js');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webkit-home-'));
}

test('env prints a shell that points the Firecrawl CLI at the engine', async () => {
  const home = sandbox();
  const { stdout } = await run(process.execPath, [bin, 'env', '--json'], {
    env: { ...process.env, WEBKIT_HOME: home, WEBKIT_PORT: '9123' },
    timeout: 60_000,
  });
  const env = JSON.parse(stdout);
  assert.equal(env.FIRECRAWL_API_URL, 'http://127.0.0.1:9123');
  assert.ok(fs.existsSync(home));
});

test('env prints cmd.exe syntax on Windows and shell syntax elsewhere', async () => {
  const home = sandbox();
  const { stdout } = await run(process.execPath, [bin, 'env'], {
    env: { ...process.env, WEBKIT_HOME: home, WEBKIT_PORT: '9124' },
    timeout: 60_000,
  });
  const line = stdout.trim();
  if (process.platform === 'win32') assert.equal(line, 'set FIRECRAWL_API_URL=http://127.0.0.1:9124');
  else assert.equal(line, 'export FIRECRAWL_API_URL=http://127.0.0.1:9124');
});

test('an unknown command is refused with the command that lists them', async () => {
  const home = sandbox();
  const result = await run(process.execPath, [bin, 'nonsense'], {
    env: { ...process.env, WEBKIT_HOME: home },
    timeout: 60_000,
  }).catch((error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown command 'nonsense'/);
});

test('-o is a value flag, not a positional', async () => {
  const { parseFlags } = await import('../src/cli.js');

  // The Firecrawl CLI writes pages with `-o file`. Reading `-o` as part of the
  // URL list would silently print the page instead of saving it.
  assert.deepEqual(parseFlags(['scrape', 'https://example.com', '-o', 'page.md']), {
    flags: { out: 'page.md' },
    positionals: ['scrape', 'https://example.com'],
  });

  assert.deepEqual(parseFlags(['search', 'sqlite wal', '-l', '5', '--json']), {
    flags: { limit: '5', json: true },
    positionals: ['search', 'sqlite wal'],
  });

  // A bare `-o` is still a flag: the command reports that it needs a value.
  assert.deepEqual(parseFlags(['scrape', 'https://example.com', '-o']), {
    flags: { out: true },
    positionals: ['scrape', 'https://example.com'],
  });
});
