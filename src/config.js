import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULTS = Object.freeze({
  host: '0.0.0.0',
  trustProxy: false,
  proxyTimeout: 60_000,
  headersTimeout: 30_000,
  requestTimeout: 300_000,
  keepAliveTimeout: 5_000,
  maxHeaderSize: 16_384,
});

const ALLOWED_KEYS = new Set(['description', 'port', 'vhosts', ...Object.keys(DEFAULTS)]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Hostname per RFC 1123 (labels of letters, digits, hyphens) or a bracketed IPv6 literal.
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TARGET_RE = /^(?:http:\/\/)?(\[[0-9a-f:.]+\]|[^/:[\]\s]+):(\d{1,5})(\/[^\s?#]*)?$/i;
const SAFE_PATH_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertPort(value, name, { allowZero = false } = {}) {
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < min || value > 65_535) {
    throw new ConfigError(`"${name}" must be an integer between ${min} and 65535`);
  }
}

function assertPositiveInt(value, name, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ConfigError(`"${name}" must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
  }
}

/** Segments of a URL path must not be able to climb out of, or hide from, a prefix. */
export function hasDotSegments(path) {
  return path.split('/').some((segment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === '.' || decoded === '..';
  });
}

/**
 * Parse a vhost key such as `example.com`, `example.com:8080` or `example.com/downloads`.
 * @returns {{ host: string, pathPrefix: string }}
 */
export function parseVhostKey(key) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ConfigError('vhost keys must be non-empty strings');
  }
  if (UNSAFE_KEYS.has(key)) {
    throw new ConfigError(`vhost key "${key}" is not allowed`);
  }
  if (/[\s?#\\]/.test(key)) {
    throw new ConfigError(`vhost key "${key}" contains invalid characters`);
  }

  const slash = key.indexOf('/');
  const rawHost = slash === -1 ? key : key.slice(0, slash);
  let pathPrefix = slash === -1 ? '' : key.slice(slash);

  const host = rawHost.toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(host);
  if (!m) {
    throw new ConfigError(`vhost key "${key}" has an invalid host`);
  }
  const [, name, port] = m;
  const isIpv6 = name.startsWith('[');
  if (isIpv6 ? isIP(name.slice(1, -1)) !== 6 : !HOSTNAME_RE.test(name)) {
    throw new ConfigError(`vhost key "${key}" has an invalid host`);
  }
  if (port !== undefined) {
    assertPort(Number(port), `vhost key "${key}" port`);
  }

  if (pathPrefix) {
    pathPrefix = pathPrefix.replace(/\/+$/, '');
    if (pathPrefix && (!SAFE_PATH_RE.test(pathPrefix) || hasDotSegments(pathPrefix))) {
      throw new ConfigError(`vhost key "${key}" has an invalid path`);
    }
  }
  return { host, pathPrefix };
}

/**
 * Parse a target such as `127.0.0.1:8080` or `10.0.0.2:8080/master/golive/upload`.
 * @returns {{ hostname: string, port: number, pathPrefix: string }}
 */
export function parseTarget(value, warn = () => {}) {
  if (typeof value !== 'string') {
    throw new ConfigError('vhost targets must be strings');
  }
  const m = TARGET_RE.exec(value.trim());
  if (!m) {
    throw new ConfigError(`invalid target "${value}" (expected host:port[/path])`);
  }
  const [, rawHost, rawPort, rawPath = ''] = m;
  const port = Number(rawPort);
  assertPort(port, `target "${value}" port`);

  const hostname = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost.toLowerCase();
  if (isIP(hostname) === 0 && !HOSTNAME_RE.test(hostname)) {
    throw new ConfigError(`target "${value}" has an invalid host`);
  }
  if (isIP(hostname) === 0 && hostname !== 'localhost') {
    warn(
      `target "${value}" uses a hostname; it is resolved on every connection. ` +
        'Prefer an IP address to avoid DNS-based surprises.',
    );
  }

  const pathPrefix = rawPath.replace(/\/+$/, '');
  if (pathPrefix && (!SAFE_PATH_RE.test(pathPrefix) || hasDotSegments(pathPrefix))) {
    throw new ConfigError(`target "${value}" has an invalid path`);
  }
  return { hostname, port, pathPrefix };
}

/**
 * Validate a raw config object and return a normalized copy with defaults applied.
 * @param {unknown} raw
 * @param {{ warn?: (msg: string) => void }} [options]
 */
export function validateConfig(raw, { warn = () => {} } = {}) {
  if (!isPlainObject(raw)) {
    throw new ConfigError('config must be a JSON object');
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ConfigError(`unknown config option "${key}"`);
    }
  }

  if (raw.port === undefined) {
    throw new ConfigError('no source listening port given ("port")');
  }
  assertPort(raw.port, 'port', { allowZero: true });

  if (raw.description !== undefined && typeof raw.description !== 'string') {
    throw new ConfigError('"description" must be a string');
  }
  if (raw.host !== undefined && (typeof raw.host !== 'string' || raw.host === '')) {
    throw new ConfigError('"host" must be a non-empty string');
  }
  if (raw.trustProxy !== undefined && typeof raw.trustProxy !== 'boolean') {
    throw new ConfigError('"trustProxy" must be a boolean');
  }
  for (const name of ['proxyTimeout', 'headersTimeout', 'requestTimeout', 'keepAliveTimeout']) {
    if (raw[name] !== undefined) assertPositiveInt(raw[name], name, { allowZero: name === 'requestTimeout' });
  }
  if (raw.maxHeaderSize !== undefined) assertPositiveInt(raw.maxHeaderSize, 'maxHeaderSize');

  if (!isPlainObject(raw.vhosts) || Object.keys(raw.vhosts).length === 0) {
    throw new ConfigError('no vhost config given ("vhosts" must be a non-empty object)');
  }

  const vhosts = [];
  const seen = new Set();
  for (const [key, value] of Object.entries(raw.vhosts)) {
    const { host, pathPrefix } = parseVhostKey(key);
    const id = `${host}${pathPrefix}`;
    if (seen.has(id)) {
      throw new ConfigError(`duplicate vhost "${id}"`);
    }
    seen.add(id);
    vhosts.push({ host, pathPrefix, target: parseTarget(value, warn) });
  }

  return {
    description: raw.description,
    port: raw.port,
    host: raw.host ?? DEFAULTS.host,
    trustProxy: raw.trustProxy ?? DEFAULTS.trustProxy,
    proxyTimeout: raw.proxyTimeout ?? DEFAULTS.proxyTimeout,
    headersTimeout: raw.headersTimeout ?? DEFAULTS.headersTimeout,
    requestTimeout: raw.requestTimeout ?? DEFAULTS.requestTimeout,
    keepAliveTimeout: raw.keepAliveTimeout ?? DEFAULTS.keepAliveTimeout,
    maxHeaderSize: raw.maxHeaderSize ?? DEFAULTS.maxHeaderSize,
    vhosts,
  };
}

/** Validate a JSON config file (resolved against the current working directory). */
export function loadConfig(file, options) {
  return validateConfig(readConfigFile(file), options);
}

/** Read and parse (but do not validate) a JSON config file. */
export function readConfigFile(file) {
  const path = resolve(process.cwd(), file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read config file ${path}: ${error.code ?? error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`config file ${path} is not valid JSON: ${error.message}`);
  }
}
