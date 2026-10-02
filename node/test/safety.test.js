import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, parseUrl, assertPublicHost, UnsafeUrlError } from '../src/safety.js';

test('private and reserved addresses are recognised', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, `${address} should be public`);
  }
  assert.equal(isPrivateAddress('not-an-address'), true);
});

test('only http and https, and no credentials, and normal ports', () => {
  assert.equal(parseUrl('https://example.com/a').protocol, 'https:');
  assert.throws(() => parseUrl('file:///etc/passwd'), UnsafeUrlError);
  assert.throws(() => parseUrl('ftp://example.com'), UnsafeUrlError);
  assert.throws(() => parseUrl('http://user:pw@example.com'), UnsafeUrlError);
  assert.throws(() => parseUrl('http://example.com:22/'), UnsafeUrlError);
  assert.throws(() => parseUrl('http://example.com:6379/'), UnsafeUrlError);
  assert.throws(() => parseUrl('not a url'), UnsafeUrlError);
  assert.equal(parseUrl('http://example.com:8080/').protocol, 'http:');
  assert.equal(parseUrl('https://example.com/').port, '');
});

test('a name that resolves into private space is refused', async () => {
  await assert.rejects(() => assertPublicHost(parseUrl('http://127.0.0.1/')), /private address/);
  // [::1] arrives bracketed and must be read as loopback, not as a bad name.
  await assert.rejects(() => assertPublicHost(parseUrl('http://[::1]/')), /private address/);
  // localhost resolves to loopback, which is the case that matters most: it
  // looks like an ordinary hostname to anything that only pattern matches.
  await assert.rejects(() => assertPublicHost(parseUrl('http://localhost/')), /private address/);
  await assert.rejects(() => assertPublicHost(parseUrl('http://169.254.169.254/')), /private address/);
});

test('an IPv4 address cannot hide behind an IPv6 literal', async () => {
  // The URL parser rewrites the dotted form to hex, so a check written against
  // "::ffff:127.0.0.1" alone never fires and loopback walks straight in.
  for (const url of [
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:a00:1]/',
    'http://[::127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
  ]) {
    await assert.rejects(() => assertPublicHost(parseUrl(url)), UnsafeUrlError, `${url} must be refused`);
  }
  // The other half of it: a public v6 address must still be fetchable.
  await assertPublicHost(parseUrl('http://[2606:4700::1111]/'));
});

test('isPrivateAddress reads the embedded v4 out of any spelling', () => {
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true);
  assert.equal(isPrivateAddress('0:0:0:0:0:ffff:7f00:1'), true);
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);
});
