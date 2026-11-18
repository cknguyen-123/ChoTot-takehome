// Readiness checks backed by the database (see ARCHITECTURE.md §7).

import { assertMigrated } from './migrate.js';

/** The database answers a trivial query. */
export function databaseCheck(pool) {
  return { name: 'database', run: () => pool.query('SELECT 1') };
}

/** Every migration shipped with this build has been applied. */
export function migrationsCheck(pool, expectedNames) {
  return { name: 'migrations', run: () => assertMigrated(pool, expectedNames) };
}
