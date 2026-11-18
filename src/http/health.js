// Liveness and readiness probes. What each reports is documented in
// ARCHITECTURE.md §7.
//
// /livez  — the process can serve HTTP. Deliberately checks no dependencies:
//           restarting the API would not fix a database outage.
// /readyz — every registered readiness check passes within its timeout.
//           Checks are added as the system grows (seed data, database, migrations).

import { Router } from 'express';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runCheck(check, timeoutMs, logger) {
  try {
    await withTimeout(Promise.resolve().then(() => check.run()), timeoutMs);
    return { name: check.name, ok: true };
  } catch (err) {
    logger.warn('readiness check failed', { check: check.name, err });
    return { name: check.name, ok: false };
  }
}

/**
 * @param {object} deps
 * @param {Array<{name: string, run: () => unknown}>} deps.readinessChecks
 *   Each `run` resolves when ready and throws/rejects when not.
 * @param {number} deps.checkTimeoutMs
 * @param {object} deps.logger
 */
export function createHealthRouter({ readinessChecks, checkTimeoutMs, logger }) {
  const router = Router();

  router.get('/livez', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.get('/readyz', async (req, res) => {
    const results = await Promise.all(
      readinessChecks.map((check) => runCheck(check, checkTimeoutMs, logger)),
    );
    const ready = results.every((r) => r.ok);

    // Only check names and pass/fail are exposed; failure details go to the logs.
    const checks = Object.fromEntries(results.map((r) => [r.name, r.ok ? 'ok' : 'failed']));
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', checks });
  });

  return router;
}
