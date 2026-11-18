// Reads configuration from environment variables once, at startup.
// Invalid values fail fast so a misconfigured container never becomes ready.

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function readInt(env, name, fallback, { min, max }) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function readEnum(env, name, fallback, allowed) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return raw;
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    // Port inside the container. The host port is mapped by docker compose from PORT.
    port: readInt(env, 'PORT', 8080, { min: 1, max: 65535 }),
    logLevel: readEnum(env, 'LOG_LEVEL', 'info', LOG_LEVELS),
    // Time allowed for in-flight requests to finish after SIGTERM before forcing exit.
    shutdownTimeoutMs: readInt(env, 'SHUTDOWN_TIMEOUT_MS', 10_000, { min: 0, max: 120_000 }),
    // Upper bound for each readiness check, so /readyz never hangs.
    readinessCheckTimeoutMs: readInt(env, 'READINESS_CHECK_TIMEOUT_MS', 2_000, { min: 1, max: 30_000 }),
    // docker-compose.yml sets this for the api container; the default suits running
    // Node directly against a local Postgres.
    databaseUrl: env.DATABASE_URL || 'postgres://moderation:moderation@localhost:5432/moderation',
    dbPoolMax: readInt(env, 'DB_POOL_MAX', 10, { min: 1, max: 100 }),

    // Worker (ARCHITECTURE.md §5.2, ASSUMPTIONS A7).
    worker: Object.freeze({
      // Jobs processed at once by one worker process.
      concurrency: readInt(env, 'WORKER_CONCURRENCY', 2, { min: 1, max: 32 }),
      // How long an idle worker waits before asking for jobs again.
      pollIntervalMs: readInt(env, 'WORKER_POLL_INTERVAL_MS', 500, { min: 10, max: 60_000 }),
      // A claimed job is reclaimable by another worker after this long (crash recovery).
      leaseMs: readInt(env, 'JOB_LEASE_MS', 30_000, { min: 100, max: 3_600_000 }),
      // Attempts before a job is marked failed.
      maxAttempts: readInt(env, 'JOB_MAX_ATTEMPTS', 5, { min: 1, max: 100 }),
      // Retry delay after attempt n fails: base × 2^(n-1), capped (2 s, 4 s, 8 s, 16 s …).
      backoffBaseMs: readInt(env, 'JOB_BACKOFF_BASE_MS', 2_000, { min: 0, max: 600_000 }),
      backoffMaxMs: readInt(env, 'JOB_BACKOFF_MAX_MS', 60_000, { min: 0, max: 3_600_000 }),
    }),
  });
}
