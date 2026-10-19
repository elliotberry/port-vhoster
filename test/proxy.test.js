import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createVhoster } from '../src/index.js';

const silent = { info() {}, warn() {}, error() {} };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { host, path = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { host, ...headers }, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Send raw bytes and collect the full response text until the socket closes. */
function raw(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.on('data', (c) => (data += c));
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
  });
}

describe('proxy', () => {
  let alpha;
  let beta;
  let vhoster;
  let port;
  let deadPort;
  let slow;
  let slowPort;
  const seen = [];

  before(async () => {
    const echo = (name) =>
      http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          seen.push({ name, headers: req.headers });
          res.setHeader('x-upstream', name);
          res.setHeader('set-cookie', ['a=1', 'b=2']);
          res.end(JSON.stringify({ name, method: req.method, url: req.url, host: req.headers.host, body }));
        });
      });

    alpha = echo('alpha');
    beta = echo('beta');
    // Minimal websocket-ish upstream: accept the upgrade and echo bytes back.
    beta.on('upgrade', (req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Upstream: beta\r\n\r\n',
      );
      socket.on('data', (d) => socket.write(d));
      socket.on('end', () => socket.end());
      socket.on('error', () => {});
    });
    slow = http.createServer(() => {}); // never responds

    const alphaPort = await listen(alpha);
    const betaPort = await listen(beta);
    slowPort = await listen(slow);
    // Reserve a port nothing listens on.
    const probe = net.createServer();
    deadPort = await listen(probe);
    await new Promise((r) => probe.close(r));

    vhoster = createVhoster(
      {
        port: 0,
        host: '127.0.0.1',
        proxyTimeout: 300,
        vhosts: {
          'a.test': `127.0.0.1:${alphaPort}`,
          'b.test': `127.0.0.1:${betaPort}`,
          'b.test/api': `127.0.0.1:${alphaPort}/internal`,
          'dead.test': `127.0.0.1:${deadPort}`,
          'slow.test': `127.0.0.1:${slowPort}`,
        },
      },
      { logger: silent },
    );
    port = (await vhoster.listen()).port;
  });

  after(async () => {
    await vhoster.close(100);
    await Promise.all(
      [alpha, beta, slow].map((s) => new Promise((r) => (s.closeAllConnections(), s.close(r)))),
    );
  });

  test('routes by Host header and preserves it upstream', async () => {
    const a = await request(port, { host: 'a.test', path: '/x?y=1' });
    assert.equal(a.status, 200);
    assert.equal(a.headers['x-upstream'], 'alpha');
    assert.deepEqual(JSON.parse(a.body), {
      name: 'alpha',
      method: 'GET',
      url: '/x?y=1',
      host: 'a.test',
      body: '',
    });

    const b = await request(port, { host: 'b.test' });
    assert.equal(JSON.parse(b.body).name, 'beta');
  });

  test('rewrites path prefixes', async () => {
    const res = await request(port, { host: 'b.test', path: '/api/users?id=2' });
    assert.equal(JSON.parse(res.body).name, 'alpha');
    assert.equal(JSON.parse(res.body).url, '/internal/users?id=2');
  });

  test('forwards request bodies and methods', async () => {
    const res = await request(port, { host: 'a.test', method: 'POST', path: '/p', body: 'hello' });
    assert.equal(JSON.parse(res.body).body, 'hello');
    assert.equal(JSON.parse(res.body).method, 'POST');
  });

  test('keeps multiple Set-Cookie headers', async () => {
    const res = await request(port, { host: 'a.test' });
    assert.deepEqual(res.headers['set-cookie'], ['a=1', 'b=2']);
  });

  test('404 for unknown host, without leaking details', async () => {
    const res = await request(port, { host: 'unknown.test' });
    assert.equal(res.status, 404);
    assert.equal(res.body, 'Not Found\n');
  });

  test('400 for traversal attempts', async () => {
    const res = await request(port, { host: 'b.test', path: '/api/../secret' });
    assert.equal(res.status, 400);
  });

  test('400 for absolute-URI request targets', async () => {
    const out = await raw(port, 'GET http://a.test/ HTTP/1.1\r\nHost: a.test\r\nConnection: close\r\n\r\n');
    assert.match(out, /^HTTP\/1\.1 400 /);
  });

  test('400 for malformed requests', async () => {
    const out = await raw(port, 'NOT HTTP AT ALL\r\n\r\n');
    assert.match(out, /^HTTP\/1\.1 400 /);
  });

  test('431 or 400 for oversized headers', async () => {
    const out = await raw(
      port,
      `GET / HTTP/1.1\r\nHost: a.test\r\nX-Big: ${'a'.repeat(40_000)}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(out, /^HTTP\/1\.1 (400|431) /);
  });

  test('502 when upstream is down, without leaking details', async () => {
    const res = await request(port, { host: 'dead.test' });
    assert.equal(res.status, 502);
    assert.equal(res.body, 'Bad Gateway\n');
  });

  test('504 when upstream times out', async () => {
    const res = await request(port, { host: 'slow.test' });
    assert.equal(res.status, 504);
  });

  test('overwrites client-supplied X-Forwarded-* by default', async () => {
    seen.length = 0;
    await request(port, {
      host: 'a.test',
      headers: {
        'x-forwarded-for': '6.6.6.6',
        'x-forwarded-host': 'evil.test',
        'x-forwarded-proto': 'https',
      },
    });
    const { headers } = seen.at(-1);
    assert.equal(headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(headers['x-forwarded-host'], 'a.test');
    assert.equal(headers['x-forwarded-proto'], 'http');
  });

  test('strips hop-by-hop headers, including those named by Connection', async () => {
    seen.length = 0;
    await request(port, {
      host: 'a.test',
      headers: {
        connection: 'x-secret, close',
        'x-secret': 'hide-me',
        'keep-alive': 'timeout=5',
        te: 'trailers',
      },
    });
    const { headers } = seen.at(-1);
    assert.equal(headers['x-secret'], undefined);
    assert.equal(headers['keep-alive'], undefined);
    assert.equal(headers.te, undefined);
  });

  test('proxies websocket upgrades bidirectionally', async () => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = '';
    const waitFor = (needle) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for ${needle}; got ${buffer}`)),
          2000,
        );
        const check = () => {
          if (buffer.includes(needle)) {
            clearTimeout(timer);
            socket.off('data', check);
            resolve();
          }
        };
        socket.on('data', check);
        check();
      });
    socket.on('data', (c) => (buffer += c));

    socket.write(
      'GET /ws HTTP/1.1\r\nHost: b.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    );
    await waitFor('\r\n\r\n');
    assert.match(buffer, /^HTTP\/1\.1 101 /);
    assert.match(buffer, /x-upstream: beta/i);

    buffer = '';
    socket.write('ping-pong');
    await waitFor('ping-pong');
    socket.destroy();
  });

  test('rejects upgrade to non-websocket protocols and unknown hosts', async () => {
    const h2c = await raw(
      port,
      'GET / HTTP/1.1\r\nHost: b.test\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n',
    );
    assert.match(h2c, /^HTTP\/1\.1 400 /);
    const unknown = await raw(
      port,
      'GET / HTTP/1.1\r\nHost: nope.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    assert.match(unknown, /^HTTP\/1\.1 404 /);
  });
});

describe('trustProxy', () => {
  test('appends to client-supplied X-Forwarded-For when enabled', async () => {
    let received;
    const upstream = http.createServer((req, res) => {
      received = req.headers;
      res.end('ok');
    });
    const upPort = await listen(upstream);
    const vhoster = createVhoster(
      { port: 0, host: '127.0.0.1', trustProxy: true, vhosts: { 'a.test': `127.0.0.1:${upPort}` } },
      { logger: silent },
    );
    const { port } = await vhoster.listen();
    await request(port, {
      host: 'a.test',
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' },
    });
    assert.equal(received['x-forwarded-for'], '1.2.3.4, 127.0.0.1');
    assert.equal(received['x-forwarded-proto'], 'https');
    await vhoster.close(100);
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  });
});

describe('createVhoster', () => {
  test('throws ConfigError for invalid config before listening', () => {
    assert.throws(() => createVhoster({ port: 80 }, { logger: silent }), /no vhost config/);
  });

  test('listen() rejects when the port is taken', async () => {
    const blocker = net.createServer();
    const taken = await listen(blocker);
    const vhoster = createVhoster(
      { port: taken, host: '127.0.0.1', vhosts: { 'a.test': '127.0.0.1:1' } },
      { logger: silent },
    );
    await assert.rejects(vhoster.listen(), /EADDRINUSE/);
    await new Promise((r) => blocker.close(r));
  });
});
