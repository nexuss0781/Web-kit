/**
 * The engine, either bundled into the package or read from a checkout.
 *
 * `scripts/bundle-engine.mjs` copies `node/src` into `sdk/engine` at pack time,
 * so the published package contains one copy of the engine and the repository
 * still has one source of truth. During development the copy may not exist yet,
 * in which case the checkout next door is used -- same code either way.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engineEnv } from './settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the engine's `src` directory. */
export function resolveEngineDir() {
  // A checkout is preferred over the bundled copy so development never runs a
  // stale engine after editing `node/src`. A published install has no checkout,
  // so it gets the copy `prepack` made.
  const candidates = [
    path.join(here, '..', '..', 'node', 'src'),
    path.join(here, '..', 'engine'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'server.js'))) return dir;
  }
  throw new Error(
    'the engine is missing from this install; reinstall webkit-sdk, or run `npm run bundle` in a checkout',
  );
}

export async function loadEngine() {
  const dir = resolveEngineDir();
  const [server, config, monitor] = await Promise.all([
    import(pathToFileURL(path.join(dir, 'server.js')).href),
    import(pathToFileURL(path.join(dir, 'config.js')).href),
    import(pathToFileURL(path.join(dir, 'monitor.js')).href),
  ]);
  return {
    dir,
    createServer: server.createServer,
    loadConfig: config.loadConfig,
    startScheduler: monitor.startScheduler,
    stopScheduler: monitor.stopScheduler,
  };
}

/**
 * The engine in this process, listening.
 *
 * Used by `webkit serve` and by the one-shot commands when no daemon is up. The
 * server is the SDK's, so closing it is the SDK's job too; nothing here reaches
 * for a global.
 */
export async function openEngine(settings) {
  const { createServer, loadConfig, startScheduler, stopScheduler } = await loadEngine();
  const config = loadConfig(engineEnv(settings));
  const server = createServer(config);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Exclusive, for the same reason `portFree` probes exclusively: on Windows a
    // plain listen can silently share a port with an unrelated process.
    server.listen({ port: settings.port, host: settings.host, exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // A daemon exists to keep promises made in an earlier request, and a monitor
  // is one of them. One-shots that open an engine in-process leave the clock
  // alone: the process would exit before a schedule came due anyway.
  if (settings.monitors !== false) startScheduler(config);

  return {
    server,
    config,
    url: `http://${settings.host}:${settings.port}`,
    close: () => new Promise((resolve) => {
      stopScheduler();
      server.close(resolve);
    }),
  };
}

/**
 * The engine's own functions, without a socket.
 *
 * `webkit search --no-start` and the programmatic client use this when no
 * daemon is running: same ladder, same shapes, one less moving part. It is also
 * how a short-lived agent avoids leaving a process behind.
 */
export async function loadSurface() {
  const dir = resolveEngineDir();
  const modules = await Promise.all([
    import(pathToFileURL(path.join(dir, 'compat.js')).href),
    import(pathToFileURL(path.join(dir, 'config.js')).href),
    import(pathToFileURL(path.join(dir, 'map.js')).href),
    import(pathToFileURL(path.join(dir, 'crawl.js')).href),
    import(pathToFileURL(path.join(dir, 'batch-scrape.js')).href),
    import(pathToFileURL(path.join(dir, 'extract.js')).href),
    import(pathToFileURL(path.join(dir, 'monitor.js')).href),
  ]);
  const [compat, config, map, crawl, batch, extract, monitor] = modules;
  return {
    v2Search: compat.v2Search,
    v2Scrape: compat.v2Scrape,
    v2DeveloperSearch: compat.v2DeveloperSearch,
    v2Map: map.v2Map,
    v2CrawlStart: crawl.v2CrawlStart,
    v2CrawlStatus: crawl.v2CrawlStatus,
    v2CrawlCancel: crawl.v2CrawlCancel,
    v2BatchStart: batch.v2BatchStart,
    v2BatchStatus: batch.v2BatchStatus,
    v2BatchCancel: batch.v2BatchCancel,
    v2ExtractStart: extract.v2ExtractStart,
    v2ExtractStatus: extract.v2ExtractStatus,
    v2ExtractCancel: extract.v2ExtractCancel,
    v2MonitorCreate: monitor.v2MonitorCreate,
    v2MonitorList: monitor.v2MonitorList,
    v2MonitorGet: monitor.v2MonitorGet,
    v2MonitorUpdate: monitor.v2MonitorUpdate,
    v2MonitorDelete: monitor.v2MonitorDelete,
    v2MonitorRun: monitor.v2MonitorRun,
    v2MonitorChecks: monitor.v2MonitorChecks,
    v2MonitorCheck: monitor.v2MonitorCheck,
    loadConfig: config.loadConfig,
  };
}
