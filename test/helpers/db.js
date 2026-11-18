// Integration-test database helper. Each test file gets its own freshly created
// database on the throwaway Postgres from `make test`, so files can run in
// parallel without seeing each other's rows.

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';

export const ADMIN_URL = process.env.TEST_DATABASE_URL;

// Lets `node --test` on a machine without Postgres skip DB tests clearly instead
// of failing; `make test` always sets TEST_DATABASE_URL.
export const dbSkip = ADMIN_URL ? false : 'TEST_DATABASE_URL not set (run `make test`)';

function urlFor(database) {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Creates an empty database. Returns its URL, a pool for it, and drop().
 * Pass {migrated: true} to apply migrations first.
 */
export async function createTestDatabase({ migrated = false } = {}) {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = urlFor(name);
  const pool = createPool({ connectionString: url, max: 20 });
  if (migrated) await migrate(pool);

  return {
    url,
    pool,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

/** A valid listing row for repository tests; override any field. */
export function sampleListing(overrides = {}) {
  return {
    sellerId: 's-1002',
    title: 'iPhone 13 128GB',
    description: 'Used, good condition',
    priceVnd: 6_000_000,
    categoryId: 'c-phones',
    submissionKey: `key-${randomUUID()}`,
    requestHash: 'hash-a',
    dedupKey: 'dedup-a',
    ...overrides,
  };
}
