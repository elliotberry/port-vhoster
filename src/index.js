import { validateConfig } from './config.js';
import { createProxyServer } from './server.js';

export { ConfigError, loadConfig, readConfigFile, validateConfig } from './config.js';
export { createRouter } from './router.js';

const noop = () => {};

/**
 * Create a vhost proxy from a raw config object.
 *
 * @param {object} rawConfig see README for the schema
 * @param {{ logger?: { info: Function, warn: Function, error: Function } }} [options]
 * @returns {{
 *   server: import('node:http').Server,
 *   listen: () => Promise<import('node:net').AddressInfo>,
 *   close: (graceMs?: number) => Promise<void>,
 * }}
 */
export function createVhoster(rawConfig, options = {}) {
  const logger = options.logger ?? console;
  const config = validateConfig(rawConfig, { warn: (msg) => (logger.warn ?? noop).call(logger, msg) });
  const { server, agent, upgraded } = createProxyServer(config, { logger });

  return {
    server,

    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          server.on('error', (error) => logger.error(`server error: ${error.message}`));
          if (config.description) logger.info(config.description);
          resolve(server.address());
        });
      });
    },

    /** Stop accepting connections; force-close whatever is left after `graceMs`. */
    close(graceMs = 5_000) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          server.closeAllConnections();
          for (const socket of upgraded) socket.destroy();
        }, graceMs);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          agent.destroy();
          resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}
