# port-vhoster

A small, dependency-free HTTP reverse proxy for sharing one port between several HTTP servers. Requests are routed by `Host` header and, optionally, by path prefix, with simple prefix rewriting.

- No runtime dependencies (built on `node:http`)
- WebSocket upgrade support
- Strict config validation (typos and unsafe values fail at startup)
- Hardened request handling (see [Security](#security))

> **Status:** small and tested, but not battle-tested under high load. Put it behind a TLS terminator and evaluate it for your use case before relying on it in production.

## Requirements

Node.js 20 or newer.

## Install

```sh
npm install -g port-vhoster
```

## Usage

```sh
port-vhoster [options] [config-file]
```

| Option            | Description                                       |
| ----------------- | ------------------------------------------------- |
| `config-file`     | JSON config file (default: `./port-vhoster.json`) |
| `-c`, `--check`   | Validate the config and exit (non-zero on error)  |
| `-h`, `--help`    | Show help                                         |
| `-v`, `--version` | Show version                                      |

Binding to a port below 1024 (such as 80) needs elevated privileges. Prefer granting the capability to the process (see the systemd example) over running as root.

`SIGINT` and `SIGTERM` trigger a graceful shutdown.

## Configuration

A config file is a single JSON object. Unknown keys are rejected.

| Key                | Type    | Default   | Description                                                              |
| ------------------ | ------- | --------- | ------------------------------------------------------------------------ |
| `description`      | string  | -         | Printed on startup.                                                      |
| `port`             | number  | required  | Port to listen on (`0` picks a free port).                               |
| `vhosts`           | object  | required  | Routes: `"host[:port][/path]"` to `"ip:port[/path]"`.                    |
| `host`             | string  | `0.0.0.0` | Interface to bind. Use `127.0.0.1` to listen on loopback only.           |
| `trustProxy`       | boolean | `false`   | Trust incoming `X-Forwarded-*` headers (only if behind another proxy).   |
| `proxyTimeout`     | number  | `60000`   | Milliseconds of upstream inactivity before answering `504`.              |
| `headersTimeout`   | number  | `30000`   | Milliseconds a client may take to send request headers.                  |
| `requestTimeout`   | number  | `300000`  | Milliseconds a client may take to send the whole request (`0` disables). |
| `keepAliveTimeout` | number  | `5000`    | Milliseconds an idle client keep-alive connection is held open.          |
| `maxHeaderSize`    | number  | `16384`   | Maximum size of request headers in bytes.                                |

### Routing rules

- Hosts are matched case-insensitively. A key without a port (`example.com`) matches any port in the `Host` header. A key with a port (`example.com:8443`) matches that exact `Host` value and is tried first.
- Within a host, the **longest matching path prefix wins**. Prefixes match whole path segments: `/downloads` matches `/downloads` and `/downloads/a.zip` but not `/downloads-old`.
- The matched prefix is replaced by the target's path: with `"example.com/uploads": "10.0.0.2:8080/master/golive/upload"`, a request for `/uploads/a.png?x=1` is sent to `10.0.0.2:8080/master/golive/upload/a.png?x=1`.
- Requests that match no vhost get `404`. Upstream failures give `502` (or `504` on timeout).
- The original `Host` header is passed on to the upstream server.

### Example

```json
{
  "description": "Routing with port sharing on port 80 for some domains and paths",
  "port": 80,
  "vhosts": {
    "www.example.com": "127.0.0.1:8081",
    "example.com": "127.0.0.1:8081",
    "example.com/downloads": "10.0.0.1:8080",
    "example.com/uploads": "10.0.0.2:8080/master/golive/upload"
  }
}
```

See [examples](examples) for more.

## Programmatic use

```js
import { createVhoster } from 'port-vhoster';

const vhoster = createVhoster({
  port: 8080,
  host: '127.0.0.1',
  vhosts: { 'app.localhost': '127.0.0.1:3000' },
});

await vhoster.listen();
// ...
await vhoster.close();
```

`createVhoster(config, { logger })` validates the config and throws a `ConfigError` on problems.

## Security

- **Path handling:** requests containing `.` or `..` segments (including percent-encoded forms), backslashes, NUL bytes, malformed percent-encoding, or an absolute-URI request target are rejected with `400`, so the proxy and upstream cannot disagree about which route applies.
- **Forwarding headers:** hop-by-hop headers (and any named in `Connection`) are stripped in both directions. `X-Forwarded-For/Host/Proto` are set from the actual connection and any client-supplied values are discarded unless `trustProxy` is `true`.
- **Config:** unknown options, duplicate vhosts, `__proto__`/`constructor`/`prototype` keys, and malformed hosts, ports, or paths are rejected at startup. Targets that use a hostname instead of an IP produce a warning, since they are re-resolved by DNS on every new connection.
- **Resource limits:** header size and header/request/keep-alive/upstream timeouts are bounded. Malformed requests get a plain `400`; error bodies never include upstream details.
- **No TLS:** this proxy speaks plain HTTP. Terminate TLS in front of it (for example with a cloud load balancer or Caddy/nginx) and set `trustProxy` accordingly. Do not expose upstream services that rely on the proxy for authentication unless you have secured the network path.
- **Only route to servers you control.** Targets come from the config file only, never from requests.

## Running as a service

systemd unit (`/etc/systemd/system/port-vhoster.service`):

```ini
[Unit]
Description=port-vhoster
After=network.target

[Service]
ExecStart=/usr/bin/env port-vhoster /etc/port-vhoster.json
Restart=on-failure
DynamicUser=yes
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

## Development

```sh
npm install
npm test
npm run lint
```

## License

MIT
