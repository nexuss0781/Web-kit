#!/usr/bin/env node
/**
 * The command, kept to a dispatch and an error boundary.
 *
 * Every command is in `src/cli.js` so that the bin stays something npm can
 * link on Windows, where a shebang is ignored and the wrapper is a `.cmd` file.
 */

import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`\nwebkit: ${error.message}\n`);
  if (process.env.WEBKIT_DEBUG) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
