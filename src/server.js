// Process entry point for the API: load config, build the app, listen, and shut
// down gracefully on SIGTERM/SIGINT (what `docker compose down` and Ctrl-C send).

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const bootLogger = createLogger();

let config;
try {
  config = loadConfig();
} catch (err) {
  bootLogger.error('invalid configuration', { err });
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel, base: { service: 'api' } });

let shuttingDown = false;

// While shutting down, report "not ready" so a load balancer stops sending new
// requests, while in-flight ones are allowed to finish.
const readinessChecks = [
  {
    name: 'accepting_traffic',
    run: () => {
      if (shuttingDown) throw new Error('shutting down');
    },
  },
];

const app = createApp({
  logger,
  readinessChecks,
  readinessCheckTimeoutMs: config.readinessCheckTimeoutMs,
});

const server = app.listen(config.port, () => {
  logger.info('listening', { port: config.port });
});

server.on('error', (err) => {
  logger.error('server failed to start', { err });
  process.exit(1);
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  const forceExit = setTimeout(() => {
    logger.error('shutdown timed out, forcing exit', { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  server.close((err) => {
    if (err) {
      logger.error('error while closing server', { err });
      process.exit(1);
    }
    logger.info('shutdown complete');
    process.exit(0);
  });
  // Keep-alive connections with no request in flight would otherwise hold close() open.
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { err: reason });
  process.exit(1);
});
