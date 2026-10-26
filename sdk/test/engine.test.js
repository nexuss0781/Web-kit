import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSurface } from '../src/engine.js';
import { engineEnv } from '../src/settings.js';

const settings = {
  host: '127.0.0.1',
  port: 8787,
  token: null,
  searxng: false,
  searxngPort: 8888,
  autoStart: false,
};

test('the bundled engine exposes the Firecrawl v2 surface', async () => {
  const surface = await loadSurface();
  assert.equal(typeof surface.v2Search, 'function');
  assert.equal(typeof surface.v2Scrape, 'function');
  assert.equal(typeof surface.v2DeveloperSearch, 'function');
  assert.equal(typeof surface.loadConfig, 'function');
});

test('a search without a query is a 400, not an upstream request', async () => {
  const surface = await loadSurface();
  const config = surface.loadConfig(engineEnv(settings, {}));
  await assert.rejects(() => surface.v2Search({}, config), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /query is required/);
    return true;
  });
});

test('an unsupported scrape format is refused by name', async () => {
  const surface = await loadSurface();
  const config = surface.loadConfig(engineEnv(settings, {}));
  await assert.rejects(
    () => surface.v2Scrape({ url: 'https://example.com', formats: ['screenshot'] }, config),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /screenshot/);
      assert.match(error.message, /markdown/);
      return true;
    },
  );
});
