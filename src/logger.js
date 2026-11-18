// Minimal structured logger: one JSON object per line on stdout/stderr.
// Enough for docker logs and log shippers without adding a dependency.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  return { name: err.name, message: err.message, stack: err.stack };
}

export function createLogger({ level = 'info', base = {}, write } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const out = write ?? ((lvl, line) => {
    (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
  });

  function log(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < threshold) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg, ...base };
    for (const [key, value] of Object.entries(fields)) {
      entry[key] = serializeError(value);
    }
    out(lvl, JSON.stringify(entry));
  }

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: (fields) => createLogger({ level, base: { ...base, ...fields }, write: out }),
  };
}

// Logger that discards everything; handy in tests.
export const silentLogger = createLogger({ write: () => {} });
