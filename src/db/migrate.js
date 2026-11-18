// Schema migrations, run with node-pg-migrate (https://salsita.github.io/node-pg-migrate/).
//
// Migrations are plain SQL files in src/db/migrations, named <timestamp>_<name>.sql,
// each with an `-- Up Migration` and a `-- Down Migration` section. They run
// automatically at startup; applied ones are recorded in the `pgmigrations` table.
//
// Several processes (API, later the worker) may start at the same time. The
// library takes a Postgres advisory lock; with advisoryLockMode 'wait' the second
// process waits for the first, then finds nothing left to apply.

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
export const MIGRATIONS_TABLE = 'pgmigrations';

/** Names of the migration files shipped with this build, without extension. */
export async function listMigrationNames(dir = MIGRATIONS_DIR) {
  return (await readdir(dir))
    .filter((file) => file.endsWith('.sql'))
    .map((file) => file.slice(0, -'.sql'.length))
    .sort();
}

/**
 * Applies pending "up" migrations. Returns the names of those it applied.
 * @param {import('pg').Pool} pool
 */
export async function migrate(pool, { dir = MIGRATIONS_DIR, logger } = {}) {
  const client = await pool.connect();
  try {
    const applied = await runner({
      dbClient: client,
      dir,
      direction: 'up',
      migrationsTable: MIGRATIONS_TABLE,
      checkOrder: true,           // refuse to run if an older file appears after newer ones ran
      singleTransaction: true,    // all pending migrations commit together or not at all
      advisoryLockMode: 'wait',   // concurrent starters queue instead of failing
      // The library is chatty; keep its progress lines at debug level.
      logger: {
        debug: () => {},
        info: (msg) => logger?.debug('node-pg-migrate', { detail: String(msg) }),
        warn: (msg) => logger?.warn('node-pg-migrate', { detail: String(msg) }),
        error: (msg) => logger?.error('node-pg-migrate', { detail: String(msg) }),
      },
    });
    const names = applied.map((m) => m.name);
    for (const name of names) logger?.info('migration applied', { migration: name });
    return names;
  } finally {
    client.release();
  }
}

/**
 * Readiness check: throws unless every expected migration has been applied.
 * @param {import('pg').Pool} pool
 * @param {string[]} expected names from listMigrationNames()
 */
export async function assertMigrated(pool, expected) {
  const { rows } = await pool.query(`SELECT name FROM ${MIGRATIONS_TABLE}`);
  const applied = new Set(rows.map((r) => r.name));
  const missing = expected.filter((name) => !applied.has(name));
  if (missing.length) throw new Error(`pending migrations: ${missing.join(', ')}`);
}
