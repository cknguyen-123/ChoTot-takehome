// The worker's polling loop: claim → process → repeat; sleep when idle.
// Runs `concurrency` independent loops in one process. Kept separate from the
// process entry point (src/worker.js) so tests can drive it directly.

import { claimJob } from '../repositories/jobs.js';

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {ReturnType<import('../services/moderation.js').createModerationService>} deps.moderation
 * @param {{concurrency: number, pollIntervalMs: number, leaseMs: number}} deps.settings
 * @param {object} deps.logger
 */
export function createWorker({ pool, moderation, settings, logger }) {
  let stopping = false;
  let loops = [];
  const sleepers = new Set();

  // Sleep that stop() can interrupt, so shutdown does not wait a poll interval.
  function idle(ms) {
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });
  }

  /** Claims and processes at most one job. Returns false when the queue was empty. */
  async function runOnce() {
    const job = await claimJob(pool, { leaseMs: settings.leaseMs });
    if (!job) return false;
    await moderation.processJob(job);
    return true;
  }

  async function loop(n) {
    while (!stopping) {
      try {
        if (!(await runOnce())) await idle(settings.pollIntervalMs);
      } catch (err) {
        // Claiming failed (e.g. database unavailable). Back off and try again;
        // any job claimed before the error is recovered by lease expiry.
        logger.error('worker loop error', { loop: n, err });
        await idle(settings.pollIntervalMs);
      }
    }
  }

  return {
    runOnce,

    start() {
      loops = Array.from({ length: settings.concurrency }, (_, i) => loop(i));
      logger.info('worker started', { concurrency: settings.concurrency });
    },

    /** Stops claiming new jobs and waits for in-flight ones to finish. */
    async stop() {
      stopping = true;
      for (const wake of [...sleepers]) wake();
      await Promise.all(loops);
    },
  };
}
