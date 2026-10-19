import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../src/config.js';
import { createRouter, normalizeHostHeader } from '../src/router.js';

function router(vhosts) {
  return createRouter(validateConfig({ port: 80, vhosts }).vhosts);
}

const r = router({
  'example.com': '127.0.0.1:1000',
  'example.com/downloads': '127.0.0.1:2000',
  'example.com/uploads': '10.0.0.2:3000/master/golive/upload',
  'example.com/a/b': '127.0.0.1:4000/x',
  'api.example.com:8443': '127.0.0.1:5000',
});

const ok = (host, url) => {
  const res = r.resolve(host, url);
  assert.ok(res.ok, `${host}${url} should route`);
  return { port: res.target.port, path: res.path };
};

test('routes by host, case-insensitively and ignoring the port', () => {
  assert.deepEqual(ok('example.com', '/'), { port: 1000, path: '/' });
  assert.deepEqual(ok('EXAMPLE.com:8080', '/x'), { port: 1000, path: '/x' });
  assert.deepEqual(ok('example.com.', '/x'), { port: 1000, path: '/x' });
});

test('unknown or missing hosts give 404', () => {
  assert.deepEqual(r.resolve('nope.test', '/'), { ok: false, status: 404 });
  assert.deepEqual(r.resolve(undefined, '/'), { ok: false, status: 404 });
  assert.deepEqual(r.resolve('exa mple.com', '/'), { ok: false, status: 404 });
});

test('longest path prefix wins and prefix is rewritten', () => {
  assert.deepEqual(ok('example.com', '/downloads'), { port: 2000, path: '/' });
  assert.deepEqual(ok('example.com', '/downloads/file.zip?x=1'), { port: 2000, path: '/file.zip?x=1' });
  assert.deepEqual(ok('example.com', '/uploads/a'), { port: 3000, path: '/master/golive/upload/a' });
  assert.deepEqual(ok('example.com', '/uploads'), { port: 3000, path: '/master/golive/upload' });
  assert.deepEqual(ok('example.com', '/a/b/c'), { port: 4000, path: '/x/c' });
  assert.deepEqual(ok('example.com', '/a/other'), { port: 1000, path: '/a/other' });
});

test('path prefixes match whole segments only', () => {
  assert.deepEqual(ok('example.com', '/downloads-evil'), { port: 1000, path: '/downloads-evil' });
  assert.deepEqual(ok('example.com', '/downloadsX/y'), { port: 1000, path: '/downloadsX/y' });
});

test('host:port keys match the Host header port exactly', () => {
  assert.deepEqual(ok('api.example.com:8443', '/'), { port: 5000, path: '/' });
  assert.deepEqual(r.resolve('api.example.com', '/'), { ok: false, status: 404 });
  assert.deepEqual(r.resolve('api.example.com:80', '/'), { ok: false, status: 404 });
});

test('rejects traversal and ambiguous paths with 400', () => {
  for (const url of [
    '/downloads/../uploads',
    '/./downloads',
    '/downloads/%2e%2e/x',
    '/downloads/%2E%2E/x',
    '/a\\b',
    '/bad%',
    '/a\0b',
    '*',
    'http://evil.test/',
    '',
  ]) {
    assert.deepEqual(r.resolve('example.com', url), { ok: false, status: 400 }, JSON.stringify(url));
  }
});

test('query strings are not treated as path', () => {
  assert.deepEqual(ok('example.com', '/downloads?next=/../x'), { port: 2000, path: '/?next=/../x' });
});

test('normalizeHostHeader', () => {
  assert.deepEqual(normalizeHostHeader('Example.COM:80'), {
    name: 'example.com',
    withPort: 'example.com:80',
  });
  assert.deepEqual(normalizeHostHeader('[::1]:80'), { name: '[::1]', withPort: '[::1]:80' });
  assert.equal(normalizeHostHeader('a b'), null);
  assert.equal(normalizeHostHeader(''), null);
  assert.equal(normalizeHostHeader('x'.repeat(300)), null);
});
