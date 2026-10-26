/**
 * Copy the engine into the package.
 *
 * `node/src` is the single source of truth: the Wasmer deployment builds from
 * it, the SDK runs it, and the tests test it. Duplicating it by hand would let
 * the two drift; copying it at pack time means the published tarball is
 * self-contained and the repository is not.
 *
 * Runs automatically from `prepack`, so `npm publish` cannot ship without it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sdk = path.join(here, '..');
const source = path.join(sdk, '..', 'node', 'src');
const target = path.join(sdk, 'engine');

if (!fs.existsSync(path.join(source, 'server.js'))) {
  throw new Error(`engine source not found at ${source}`);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, {
  recursive: true,
  filter: (entry) => {
    const name = path.basename(entry);
    return name !== '__pycache__' && !name.endsWith('.test.js');
  },
});

// The engine is ESM and is imported by absolute path, so it needs its own
// package boundary once it is outside the package that declared the type.
fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({
  name: 'webkit-engine',
  private: true,
  type: 'module',
}, null, 2)}\n`);

let files = 0;
let bytes = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      files += 1;
      bytes += fs.statSync(full).size;
    }
  }
};
walk(target);

console.log(`engine bundled: ${files} files, ${(bytes / 1024).toFixed(1)} kB`);
