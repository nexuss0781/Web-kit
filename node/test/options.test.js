import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOptions } from '../src/fetcher.js';

test('an unnamed option keeps its default rather than becoming undefined', () => {
  // A route fills every documented key from the request body, so the keys the
  // caller did not mention arrive as undefined. Treating that as false turns
  // robots and redirects off on almost every request.
  const fromRoute = resolveOptions({
    mode: undefined,
    render: undefined,
    timeout_ms: undefined,
    max_bytes: undefined,
    follow_redirects: undefined,
    respect_robots: undefined,
    include_links: undefined,
    include_images: undefined,
  });

  assert.equal(fromRoute.mode, 'markdown');
  assert.equal(fromRoute.render, 'never');
  assert.equal(fromRoute.respect_robots, true);
  assert.equal(fromRoute.follow_redirects, true);
  assert.equal(fromRoute.include_links, true);
  assert.equal(fromRoute.include_images, false);
  assert.equal(fromRoute.timeout_ms, 12_000);
});

test('an option the caller did name still wins', () => {
  const options = resolveOptions({ mode: 'metadata', respect_robots: false, timeout_ms: 250, maxRedirects: 0 });
  assert.equal(options.mode, 'metadata');
  assert.equal(options.respect_robots, false);
  assert.equal(options.timeout_ms, 250);
  assert.equal(options.maxRedirects, 0);
});

test('no options at all is the same as the defaults', () => {
  assert.deepEqual(resolveOptions(), resolveOptions({}));
});
