import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, parseTarget, parseVhostKey, validateConfig } from '../src/config.js';

const base = { port: 8080, vhosts: { 'example.com': '127.0.0.1:9000' } };

test('applies defaults and normalizes entries', () => {
  const config = validateConfig({
    ...base,
    vhosts: { 'WWW.Example.COM/downloads/': '10.0.0.2:8080/master/' },
  });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.trustProxy, false);
  assert.deepEqual(config.vhosts, [
    {
      host: 'www.example.com',
      pathPrefix: '/downloads',
      target: { hostname: '10.0.0.2', port: 8080, pathPrefix: '/master' },
    },
  ]);
});

test('requires port and vhosts', () => {
  assert.throws(() => validateConfig({ vhosts: base.vhosts }), /no source listening port/);
  assert.throws(() => validateConfig({ port: 80 }), /no vhost config/);
  assert.throws(() => validateConfig({ port: 80, vhosts: {} }), /no vhost config/);
  assert.throws(() => validateConfig([]), ConfigError);
  assert.throws(() => validateConfig(null), ConfigError);
});

test('rejects bad ports and option types', () => {
  for (const port of [-1, 65536, 1.5, '80', null]) {
    assert.throws(() => validateConfig({ ...base, port }), ConfigError, String(port));
  }
  assert.throws(() => validateConfig({ ...base, trustProxy: 'yes' }), /trustProxy/);
  assert.throws(() => validateConfig({ ...base, proxyTimeout: 0 }), /proxyTimeout/);
  assert.throws(() => validateConfig({ ...base, description: 5 }), /description/);
});

test('rejects unknown top-level options (typos)', () => {
  assert.throws(() => validateConfig({ ...base, trustProxie: true }), /unknown config option/);
});

test('rejects unsafe or malformed vhost keys', () => {
  for (const key of [
    '__proto__',
    'constructor',
    'prototype',
    '',
    'exa mple.com',
    'a.com/../b',
    'a.com/%2e%2e/b',
    'a.com\\b',
  ]) {
    assert.throws(() => parseVhostKey(key), ConfigError, key);
  }
});

test('JSON.parse-created __proto__ key is rejected', () => {
  const raw = JSON.parse('{"port": 80, "vhosts": {"__proto__": "127.0.0.1:1"}}');
  assert.throws(() => validateConfig(raw), /not allowed/);
});

test('rejects duplicate vhosts after normalization', () => {
  assert.throws(
    () => validateConfig({ port: 80, vhosts: { 'A.com': '127.0.0.1:1', 'a.com': '127.0.0.1:2' } }),
    /duplicate/,
  );
});

test('parses host:port and ipv6 keys', () => {
  assert.deepEqual(parseVhostKey('example.com:8080'), { host: 'example.com:8080', pathPrefix: '' });
  assert.deepEqual(parseVhostKey('[::1]/x'), { host: '[::1]', pathPrefix: '/x' });
});

test('parses targets', () => {
  assert.deepEqual(parseTarget('127.0.0.1:8080'), { hostname: '127.0.0.1', port: 8080, pathPrefix: '' });
  assert.deepEqual(parseTarget('http://[::1]:80/a/b'), { hostname: '::1', port: 80, pathPrefix: '/a/b' });
});

test('rejects bad targets', () => {
  for (const target of [
    '127.0.0.1',
    '127.0.0.1:0',
    '127.0.0.1:99999',
    'host:80/../x',
    'host:80/a?b=c',
    'https://x:1',
    5,
    null,
  ]) {
    assert.throws(() => parseTarget(target), ConfigError, String(target));
  }
});

test('warns about hostname targets but not IPs or localhost', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  parseTarget('127.0.0.1:1', warn);
  parseTarget('localhost:1', warn);
  assert.equal(warnings.length, 0);
  parseTarget('backend.internal:1', warn);
  assert.equal(warnings.length, 1);
});
