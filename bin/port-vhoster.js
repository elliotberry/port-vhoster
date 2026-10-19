#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig, readConfigFile } from '../src/config.js';
import { createVhoster } from '../src/index.js';

const HELP = `Usage: port-vhoster [options] [config-file]

Share one port between several HTTP servers, routed by Host header and path.

Arguments:
  config-file     JSON config (default: ./port-vhoster.json)

Options:
  -c, --check     Validate the config and exit
  -h, --help      Show this help
  -v, --version   Show the version
`;

function fail(message, code = 1) {
  console.error(`port-vhoster: ${message}`);
  process.exit(code);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      check: { type: 'boolean', short: 'c' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
} catch (error) {
  fail(`${error.message}\n\n${HELP}`, 2);
}

const { values, positionals } = args;

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}
if (positionals.length > 1) {
  fail(`expected at most one config file\n\n${HELP}`, 2);
}

const file = positionals[0] ?? 'port-vhoster.json';

let vhoster;
try {
  if (values.check) {
    const config = loadConfig(file, { warn: (msg) => console.warn(`warning: ${msg}`) });
    const n = config.vhosts.length;
    console.log(`${file}: OK (${n} vhost${n === 1 ? '' : 's'})`);
    process.exit(0);
  }
  vhoster = createVhoster(readConfigFile(file), { logger: console });
} catch (error) {
  if (error instanceof ConfigError) fail(error.message);
  throw error;
}

try {
  const address = await vhoster.listen();
  console.log(`port-vhoster listening on ${address.address}:${address.port}`);
} catch (error) {
  fail(`cannot listen: ${error.message}`);
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  await vhoster.close(10_000);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    console.error(`${event}:`, error);
    process.exit(1);
  });
}
