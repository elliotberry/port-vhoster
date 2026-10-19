import http from 'node:http';
import { pipeline } from 'node:stream';
import { createRouter } from './router.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const STATUS_TEXT = {
  400: 'Bad Request',
  404: 'Not Found',
  502: 'Bad Gateway',
  504: 'Gateway Timeout',
};

/** Remove hop-by-hop headers, plus any header named in the `Connection` header. */
function stripHopByHop(headers) {
  const named = String(headers.connection ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name) && !named.includes(name)) out[name] = value;
  }
  return out;
}

function forwardedHeaders(req, trustProxy) {
  const clientIp = req.socket.remoteAddress ?? '';
  const encrypted = Boolean(req.socket.encrypted);
  const headers = {
    'x-forwarded-for': clientIp,
    'x-forwarded-host': req.headers.host ?? '',
    'x-forwarded-proto': encrypted ? 'https' : 'http',
  };
  if (trustProxy) {
    const prior = req.headers['x-forwarded-for'];
    if (prior) headers['x-forwarded-for'] = `${prior}, ${clientIp}`;
    headers['x-forwarded-host'] = req.headers['x-forwarded-host'] ?? headers['x-forwarded-host'];
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? headers['x-forwarded-proto'];
  }
  return headers;
}

function upstreamHeaders(req, trustProxy) {
  const headers = stripHopByHop(req.headers);
  // Never let clients choose these unless the operator explicitly trusts upstream proxies.
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  return { ...headers, ...forwardedHeaders(req, trustProxy) };
}

function sendError(res, status) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `${STATUS_TEXT[status] ?? 'Error'}\n`;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'close',
  });
  res.end(body);
}

function rejectSocket(socket, status) {
  if (socket.writable) {
    const body = `${STATUS_TEXT[status] ?? 'Error'}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n\r\n' +
        body,
    );
  } else {
    socket.destroy();
  }
}

/**
 * Create (but do not start) a vhost proxy.
 * @param {ReturnType<import('./config.js').validateConfig>} config validated config
 * @param {{ logger?: { info: Function, warn: Function, error: Function } }} [options]
 */
export function createProxyServer(config, { logger = console } = {}) {
  const router = createRouter(config.vhosts);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256, timeout: config.proxyTimeout });
  const upgraded = new Set();

  const server = http.createServer({ maxHeaderSize: config.maxHeaderSize }, (req, res) => {
    const route = router.resolve(req.headers.host, req.url);
    if (!route.ok) return sendError(res, route.status);

    const { target, path } = route;
    const upstream = http.request({
      agent,
      host: target.hostname,
      port: target.port,
      method: req.method,
      path,
      headers: upstreamHeaders(req, config.trustProxy),
      timeout: config.proxyTimeout,
    });

    upstream.on('timeout', () =>
      upstream.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    );
    upstream.on('error', (error) => {
      logger.warn(`upstream ${target.hostname}:${target.port} failed: ${error.code ?? error.message}`);
      sendError(res, error.code === 'ETIMEDOUT' ? 504 : 502);
    });
    upstream.on('response', (upRes) => {
      res.writeHead(upRes.statusCode, upRes.statusMessage, stripHopByHop(upRes.headers));
      pipeline(upRes, res, () => {});
    });

    // Tear down the upstream request if the client goes away mid-flight.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    pipeline(req, upstream, () => {});
  });

  server.headersTimeout = config.headersTimeout;
  server.requestTimeout = config.requestTimeout;
  server.keepAliveTimeout = config.keepAliveTimeout;

  server.on('clientError', (error, socket) => {
    if (error.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    rejectSocket(socket, 400);
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());

    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      return rejectSocket(socket, 400);
    }
    const route = router.resolve(req.headers.host, req.url);
    if (!route.ok) return rejectSocket(socket, route.status);

    const { target, path } = route;
    const headers = upstreamHeaders(req, config.trustProxy);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';

    // A dedicated agent-less request: the socket is handed over, not pooled.
    const upstream = http.request({
      host: target.hostname,
      port: target.port,
      method: req.method,
      path,
      headers,
      timeout: config.proxyTimeout,
    });

    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', (error) => {
      logger.warn(
        `upstream ${target.hostname}:${target.port} websocket failed: ${error.code ?? error.message}`,
      );
      rejectSocket(socket, error.code === 'ETIMEDOUT' ? 504 : 502);
    });

    // Upstream declined the upgrade: relay its answer and close.
    upstream.on('response', (upRes) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
      const safe = stripHopByHop(upRes.headers);
      for (const [name, value] of Object.entries(safe)) {
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
      }
      lines.push('Connection: close', '', '');
      socket.write(lines.join('\r\n'));
      pipeline(upRes, socket, () => {});
    });

    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      upgraded.add(socket);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
      socket.on('close', () => {
        upgraded.delete(socket);
        upSocket.destroy();
      });
      upSocket.on('close', () => socket.destroy());

      // Long-lived tunnel: disable idle timeouts imposed for plain HTTP.
      socket.setTimeout(0);
      upSocket.setTimeout(0);
      socket.setNoDelay(true);
      upSocket.setNoDelay(true);

      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      }
      lines.push('', '');
      socket.write(lines.join('\r\n'));
      if (upHead?.length) socket.write(upHead);

      upSocket.pipe(socket);
      socket.pipe(upSocket);
      // HTTP server sockets allow half-open connections; a tunnel must not linger
      // once the client has hung up.
      socket.on('end', () => socket.end());
    });

    socket.on('close', () => upstream.destroy());
    // `head` is normally empty: clients wait for the 101 before sending frames.
    if (head?.length) socket.unshift(head);
    upstream.end();
  });

  return { server, agent, upgraded };
}
