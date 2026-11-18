import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { databaseCheck, migrationsCheck } from '../src/db/health.js';
import { listMigrationNames, migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { silentLogger } from '../src/logger.js';
import { createTestDatabase, dbSkip } from './helpers/db.js';
import { startTestServer } from './helpers/http.js';

async function readyz(pool, names) {
  const app = createApp({
    logger: silentLogger,
    readinessChecks: [databaseCheck(pool), migrationsCheck(pool, names)],
    readinessCheckTimeoutMs: 2_000,
  });
  const server = await startTestServer(app);
  try {
    const res = await fetch(`${server.baseUrl}/readyz`);
    return { status: res.status, body: await res.json() };
  } finally {
    await server.close();
  }
}

describe('/readyz with database checks', () => {
  it('is 503 when the database is unreachable (and /readyz still answers)', async () => {
    // Nothing listens on port 1: connection is refused immediately.
    const pool = createPool({ connectionString: 'postgres://x:y@127.0.0.1:1/none' });
    try {
      const { status, body } = await readyz(pool, ['any']);
      assert.equal(status, 503);
      assert.deepEqual(body.checks, { database: 'failed', migrations: 'failed' });
    } finally {
      await pool.end();
    }
  });

  describe('real Postgres', { skip: dbSkip }, () => {
    let names;
    before(async () => { names = await listMigrationNames(); });

    it('is 503 before migrations and 200 after', async () => {
      const db = await createTestDatabase();
      try {
        const pending = await readyz(db.pool, names);
        assert.equal(pending.status, 503);
        assert.deepEqual(pending.body.checks, { database: 'ok', migrations: 'failed' });

        await migrate(db.pool);
        const migrated = await readyz(db.pool, names);
        assert.equal(migrated.status, 200);
        assert.deepEqual(migrated.body.checks, { database: 'ok', migrations: 'ok' });
      } finally {
        await db.drop();
      }
    });
  });
});
