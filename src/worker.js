// Process entry point for the moderation worker (a separate container from the
// API; same image). Startup: config → seed → pool → migrations → loops.
// On SIGTERM/SIGINT it stops claiming, finishes in-flight jobs, then exits. A
// job interrupted by a hard kill is recovered by lease expiry.

import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createLogger } from './logger.js';
import { loadSeed } from './reference/seed.js';
import { createModerationService } from './services/moderation.js';
import { createWorker } from './worker/loop.js';

const bootLogger = createLogger();

let config;
try {
  config = loadConfig();
} catch (err) {
  bootLogger.error('invalid configuration', { err });
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel, base: { service: 'worker' } });

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { err: reason });
  process.exit(1);
});

let pool;
let worker;
let shuttingDown = false;

async function start() {
  const seed = await loadSeed();
  pool = createPool({ connectionString: config.databaseUrl, max: config.worker.concurrency + 2, logger });
  // The API runs migrations too; the advisory lock makes one wait for the other.
  await migrate(pool, { logger });

  const moderation = createModerationService({ pool, seed, settings: config.worker, logger });
  worker = createWorker({ pool, moderation, settings: config.worker, logger });
  if (shuttingDown) return;
  worker.start();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  const forceExit = setTimeout(() => {
    logger.error('shutdown timed out, forcing exit', { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    await worker?.stop();
    await pool?.end();
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('error during shutdown', { err });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  logger.error('startup failed', { err });
  process.exit(1);
});
