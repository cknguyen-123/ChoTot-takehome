// PostgreSQL connection pool and a transaction helper.

import pg from 'pg';

const INT8_OID = 20;

// pg returns bigint (int8) as a string, because it can exceed JavaScript's safe
// integer range. price_vnd is the only bigint we read and request validation
// caps it at Number.MAX_SAFE_INTEGER, so it is safe to return it as a number,
// which is what the API contract (`type: integer`) expects. Scoped to our pool
// instead of changing pg's global parsers.
const types = {
  getTypeParser(oid, format) {
    if (oid === INT8_OID && format !== 'binary') return (value) => Number(value);
    return pg.types.getTypeParser(oid, format);
  },
};

/**
 * @param {object} options
 * @param {string} options.connectionString
 * @param {number} [options.max] maximum connections in the pool
 * @param {object} [options.logger]
 */
export function createPool({ connectionString, max = 10, logger }) {
  const pool = new pg.Pool({
    connectionString,
    max,
    types,
    // Fail fast instead of queueing forever when the database is unreachable.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client losing its connection (e.g. Postgres restart) emits 'error'
  // on the pool; without a listener that would crash the process.
  pool.on('error', (err) => logger?.warn('idle database client error', { err }));
  return pool;
}

/**
 * Runs `fn(client)` inside BEGIN/COMMIT on one connection; rolls back if it throws.
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
