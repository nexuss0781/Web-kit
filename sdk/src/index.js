/**
 * Web-Kit, as a library.
 *
 *   import { createClient } from 'webkit-sdk';
 *   const web = await createClient();
 *   const result = await web.search({ query: 'sqlite wal mode', limit: 5 });
 *
 * `createClient()` talks to the daemon when one is running and runs the same
 * engine in-process when one is not, so there is no setup step in the middle of
 * an agent's work. The shapes are Firecrawl's v2 envelopes either way.
 */

export { createClient, search, scrape } from './client.js';
export { doctor } from './doctor.js';
export { readSettings, writeSettings, DEFAULTS } from './settings.js';
export { paths } from './paths.js';
export { provision, installed as searxngInstalled, findPython } from './searxng.js';
export { start as startDaemon, stop as stopDaemon, readDaemon, isRunning } from './daemon.js';
