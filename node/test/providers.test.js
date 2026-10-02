import test from 'node:test';
import assert from 'node:assert/strict';
import { phrase } from '../src/providers/arxiv.js';
import { describeProviders, enabledProviders, allProviders } from '../src/providers/index.js';

test('an arxiv query is reduced to words its parser accepts', () => {
  // The query language reads quotes, brackets and AND/OR as syntax, so leaving
  // them in turns a search into a 400.
  assert.equal(phrase('what is a quasar'), 'what is a quasar');
  assert.equal(phrase('a "quoted" word'), 'a quoted word');
  assert.equal(phrase('model AND (attention OR dropout)'), 'model attention dropout');
  assert.equal(phrase('back\\slash'), 'back slash');
  assert.equal(phrase('   '), '');
  assert.equal(phrase('"'), '');
});

test('every provider declares an id and the search capability', () => {
  const providers = allProviders();
  const ids = providers.map((provider) => provider.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const provider of providers) {
    assert.ok(provider.id, 'has an id');
    assert.ok(provider.label, `${provider.id} has a label`);
    assert.ok(provider.capabilities.includes('search'), `${provider.id} can search`);
    assert.equal(typeof provider.search, 'function');
  }
});

test('searxng is only in the default set when instances are configured', () => {
  const withInstances = enabledProviders({ searxngUrls: ['http://searxng:8080'] }).map((p) => p.id);
  const without = enabledProviders({ searxngUrls: [] }).map((p) => p.id);

  assert.ok(withInstances.includes('searxng'));
  assert.ok(!without.includes('searxng'), 'there is nothing to point it at');
  assert.ok(without.includes('wikipedia'), 'the keyless providers need no configuration');
});

test('an explicit provider list narrows the default set', () => {
  assert.deepEqual(enabledProviders({ searxngUrls: [], providers: ['wikipedia', 'github'] }).map((p) => p.id), [
    'wikipedia',
    'github',
  ]);
  // Names that do not exist are dropped rather than throwing the whole run.
  assert.deepEqual(enabledProviders({ searxngUrls: [], providers: ['nope'] }), []);
});

test('what the registry reports matches what will run', () => {
  const described = describeProviders({ searxngUrls: ['http://searxng:8080'] });
  const enabled = new Set(enabledProviders({ searxngUrls: ['http://searxng:8080'] }).map((p) => p.id));
  for (const entry of described) {
    assert.equal(entry.enabled, enabled.has(entry.id), `${entry.id} is reported accurately`);
  }
});
