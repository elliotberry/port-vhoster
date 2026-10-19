import { hasDotSegments } from './config.js';

/**
 * Normalize a Host header into `{ name, withPort }`, both lowercased.
 * Returns null for missing or malformed values.
 */
export function normalizeHostHeader(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 262) return null;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value.toLowerCase());
  if (!m) return null;
  // A trailing dot denotes an absolute FQDN; treat it as equivalent.
  const name = m[1].endsWith('.') ? m[1].slice(0, -1) : m[1];
  return { name, withPort: m[2] ? `${name}:${m[2]}` : name };
}

function matches(pathname, pathPrefix) {
  return pathPrefix === '' || pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`);
}

/**
 * Build a router from validated vhost entries (see `validateConfig`).
 *
 * Matching rules:
 *  - The host is compared case-insensitively. A vhost key with a port (`example.com:8080`)
 *    is tried against the `Host` header including its port first; then hostname-only keys.
 *  - Within a host, the longest matching path prefix wins. Prefixes match on whole
 *    path segments only (`/downloads` does not match `/downloads-evil`).
 *  - The matched prefix is replaced by the target's path prefix.
 */
export function createRouter(vhosts) {
  /** @type {Map<string, Array<{ pathPrefix: string, target: object }>>} */
  const table = new Map();
  for (const { host, pathPrefix, target } of vhosts) {
    if (!table.has(host)) table.set(host, []);
    table.get(host).push({ pathPrefix, target });
  }
  for (const routes of table.values()) {
    routes.sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  }

  return {
    /**
     * @param {string | undefined} hostHeader raw `Host` header value
     * @param {string} url raw request target (must be origin-form, e.g. `/a/b?c=d`)
     * @returns {{ ok: true, target: object, path: string }
     *   | { ok: false, status: 400 | 404 }}
     */
    resolve(hostHeader, url) {
      if (typeof url !== 'string' || !url.startsWith('/')) {
        return { ok: false, status: 400 };
      }
      const queryIndex = url.indexOf('?');
      const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
      const search = queryIndex === -1 ? '' : url.slice(queryIndex);

      // Reject anything that could make the proxy and the upstream disagree about the path.
      if (/[\\\0]/.test(pathname) || hasDotSegments(pathname)) {
        return { ok: false, status: 400 };
      }

      const host = normalizeHostHeader(hostHeader);
      if (host === null) return { ok: false, status: 404 };

      for (const key of new Set([host.withPort, host.name])) {
        for (const { pathPrefix, target } of table.get(key) ?? []) {
          if (matches(pathname, pathPrefix)) {
            const path = `${target.pathPrefix}${pathname.slice(pathPrefix.length)}` || '/';
            return { ok: true, target, path: `${path}${search}` };
          }
        }
      }
      return { ok: false, status: 404 };
    },
  };
}
