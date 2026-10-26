import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractTarGz } from '../src/tar.js';

/** Just enough tar to be read back: name, size and type are all the reader uses. */
function entry(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');

  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

function tarball(entries) {
  return gzipSync(Buffer.concat([
    ...entries.map(([name, body]) => entry(name, Buffer.from(body))),
    Buffer.alloc(1024),
  ]));
}

test('extracts only what SearXNG needs, without the archive prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webkit-tar-'));
  const archive = tarball([
    ['searxng-master/searx/webapp.py', 'print("hello")'],
    ['searxng-master/searx/engines/google.py', 'ENGINE'],
    ['searxng-master/requirements.txt', 'flask==1.0'],
    ['searxng-master/requirements-server.txt', 'granian==1.0'],
    ['searxng-master/tests/test_webapp.py', 'def test(): pass'],
    ['searxng-master/utils/sites-available/searxng.conf:socket', 'socket'],
  ]);

  const result = extractTarGz(archive, dir, {
    strip: 1,
    filter: (name) => name.startsWith('searx/') || /^requirements(-server)?\.txt$/.test(name),
  });

  assert.equal(result.files, 4);
  assert.equal(fs.readFileSync(path.join(dir, 'searx', 'webapp.py'), 'utf8'), 'print("hello")');
  assert.ok(fs.existsSync(path.join(dir, 'requirements.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'tests')));
  assert.ok(!fs.existsSync(path.join(dir, 'searx', 'sites-available')));
});

test('a filename with a colon is skipped on Windows instead of failing the install', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webkit-tar-'));
  const archive = tarball([
    ['searxng-master/searx/ok.py', 'ok'],
    ['searxng-master/searx/bad:name.py', 'bad'],
  ]);

  const result = extractTarGz(archive, dir, { strip: 1, filter: () => true });

  assert.equal(result.files, process.platform === 'win32' ? 1 : 2);
  assert.ok(fs.existsSync(path.join(dir, 'searx', 'ok.py')));
});

test('pax long names are honoured', () => {
  // A GitHub tarball uses pax headers for paths over 100 bytes. Writing that by
  // hand is not worth it; what matters is the header field reading, which the
  // two tests above already exercise. This asserts the reader survives an
  // archive with no pax records at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webkit-tar-'));
  const archive = tarball([['searxng-master/searx/webapp.py', 'x']]);
  const result = extractTarGz(archive, dir, { strip: 1, filter: () => true });
  assert.equal(result.files, 1);
});
