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
  });
}
