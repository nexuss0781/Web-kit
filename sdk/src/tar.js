/**
 * A tar reader, because the alternative is requiring git and hoping.
 *
 * SearXNG's repository contains `utils/.../searxng.conf:socket`. That colon is
 * legal in a git tree and illegal in a Windows filename, so `git clone` cannot
 * check the tree out on Windows at all -- not with `--depth`, not with
 * `--sparse`, not with `git archive`, all of which still write the index before
 * filtering. A tarball is just bytes, so it has no such problem: we read the
 * archive and write only the entries a running instance needs.
 *
 * This is deliberately small. It handles regular files, directories, and the
 * GNU/PAX long-name extensions a GitHub tarball uses. It ignores links, devices
 * and permissions, none of which matter for `python -m searx.webapp`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

function cstr(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function octal(buffer, start, length) {
  const text = cstr(buffer, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parsePax(body) {
  const fields = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(body.subarray(offset, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) fields[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return fields;
}

/**
 * Every entry in the archive, unchanged.
 *
 * The caller filters, because "which files does SearXNG need" is a decision
 * about SearXNG and does not belong in an archive reader.
 */
export function* tarEntries(tar) {
  let offset = 0;
  let pax = {};
  let longName = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'x') { pax = parsePax(body); continue; }
    if (type === 'L') { longName = body.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'g') continue;

    const name = pax.path || longName
      || [cstr(header, 345, 155), cstr(header, 0, 100)].filter(Boolean).join('/');
    pax = {};
    longName = null;
    yield { name, type, body, size };
  }
}

/**
 * Unpack a `.tar.gz` into `dest`.
 *
 * `strip` removes leading path components (GitHub puts everything under
 * `searxng-master/`), and `filter` receives the stripped name so it can decide
 * using a path that looks like the destination.
 *
 * Directory entries are created even when their files are filtered out only if
 * a kept file needs them, which keeps the tree empty where the archive is not.
 */
export function extractTarGz(archive, dest, { filter = () => true, strip = 1 } = {}) {
  const tar = gunzipSync(archive);
  let files = 0;
  let bytes = 0;

  for (const entry of tarEntries(tar)) {
    const parts = entry.name.split('/');
    const name = parts.length > strip ? parts.slice(strip).join('/') : '';
    if (!name || name.endsWith('/')) continue;
    if (entry.type !== '0' && entry.type !== '\0') continue;
    if (!filter(name, entry)) continue;
    // A Windows filesystem cannot store a colon, and nothing SearXNG runs
    // needs the file that has one.
    if (process.platform === 'win32' && /[:*?"<>|]/.test(name)) continue;

    const target = path.join(dest, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.body);
    files += 1;
    bytes += entry.size;
  }

  return { files, bytes };
}
