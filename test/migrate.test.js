import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertMigrated, listMigrationNames, migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { createTestDatabase, dbSkip } from './helpers/db.js';

describe('migrations (real Postgres)', { skip: dbSkip }, () => {
  let db;
  let expected;

  before(async () => {
    db = await createTestDatabase();
    expected = await listMigrationNames();
  });
  after(() => db?.drop());

  it('reports pending migrations on an empty database', async () => {
    // The tracking table does not exist yet, so the readiness check must fail.
    await assert.rejects(assertMigrated(db.pool, expected));
  });

  it('applies every migration on first run, from several processes at once', async () => {
    // Two pools stand in for API and worker starting together: the advisory lock
    // must make one wait for the other, and each migration must run exactly once.
    const other = createPool({ connectionString: db.url });
    try {
      const [a, b] = await Promise.all([migrate(db.pool), migrate(other)]);
      assert.deepEqual([...a, ...b].sort(), expected);
    } finally {
      await other.end();
    }
    await assertMigrated(db.pool, expected);
  });

  it('does nothing when run again', async () => {
    assert.deepEqual(await migrate(db.pool), []);
  });

  it('creates the expected tables', async () => {
    const { rows } = await db.pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const t of ['listings', 'moderation_jobs', 'pgmigrations']) assert.ok(tables.includes(t), t);
  });
});
