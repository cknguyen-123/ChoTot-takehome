// Process entry point for the API. Startup order:
//   1. config  2. seed data  3. database pool  4. migrations  5. listen
// Any failure in 1–4 exits non-zero with a log line, so a broken container never
// looks healthy. Shuts down gracefully on SIGTERM/SIGINT (`docker compose down`, Ctrl-C).

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { databaseCheck, migrationsCheck } from './db/health.js';
import { listMigrationNames, migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createLogger } from './logger.js';
import { loadSeed } from './reference/seed.js';
import { createListingService } from './services/listings.js';
import { createReviewService } from './services/review.js';

const bootLogger = createLogger();

let config;
try {
  config = loadConfig();
} catch (err) {
  bootLogger.error('invalid configuration', { err });
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel, base: { service: 'api' } });

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { err: reason });
  process.exit(1);
});

let shuttingDown = false;
let server;
let pool;

async function start() {
  const seed = await loadSeed();
  logger.info('seed loaded', {
    sellers: seed.sellers.size,
    categories: seed.categories.size,
    bannedKeywords: seed.bannedKeywords.length,
  });

  pool = createPool({ connectionString: config.databaseUrl, max: config.dbPoolMax, logger });
  await migrate(pool, { logger });
  const migrationNames = await listMigrationNames();

  const readinessChecks = [
    // While shutting down, report "not ready" so a load balancer stops sending
    // new requests, while in-flight ones are allowed to finish.
    { name: 'accepting_traffic', run: () => { if (shuttingDown) throw new Error('shutting down'); } },
    // The process only gets this far with valid seed data; listed so /readyz shows it.
    { name: 'seed', run: () => {} },
    databaseCheck(pool),
    migrationsCheck(pool, migrationNames),
  ];

  const listingService = createListingService({ pool, seed, logger });
  const app = createApp({
    logger,
    readinessChecks,
    readinessCheckTimeoutMs: config.readinessCheckTimeoutMs,
    listingService,
    reviewService: createReviewService({ pool, logger }),
  });

  server = app.listen(config.port, () => logger.info('listening', { port: config.port }));
  server.on('error', (err) => {
    logger.error('server failed to start', { err });
    process.exit(1);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  const forceExit = setTimeout(() => {
    logger.error('shutdown timed out, forcing exit', { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  const closeServer = server
    ? new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      // Keep-alive connections with no request in flight would otherwise hold close() open.
      server.closeIdleConnections();
    })
    : Promise.resolve();

  closeServer
    .then(() => pool?.end())
    .then(() => {
      logger.info('shutdown complete');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('error during shutdown', { err });
      process.exit(1);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  logger.error('startup failed', { err });
  process.exit(1);
});
