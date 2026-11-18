// Builds the Express application. Kept separate from server.js so tests can
// create an app with their own dependencies and no open port or signal handlers.

import express from 'express';
import { createErrorHandler, notFoundHandler } from './http/errors.js';
import { createHealthRouter } from './http/health.js';

// Large enough for a 200-char title plus a 5000-char description in multi-byte
// UTF-8 (Vietnamese), small enough to reject abuse early.
const JSON_BODY_LIMIT = '64kb';

/**
 * @param {object} deps
 * @param {object} deps.logger
 * @param {Array<{name: string, run: () => unknown}>} [deps.readinessChecks]
 * @param {number} [deps.readinessCheckTimeoutMs]
 */
export function createApp({ logger, readinessChecks = [], readinessCheckTimeoutMs = 2_000 }) {
  const app = express();
  app.disable('x-powered-by');

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(createHealthRouter({ readinessChecks, checkTimeoutMs: readinessCheckTimeoutMs, logger }));

  // /v1 routes are added in later phases.

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
