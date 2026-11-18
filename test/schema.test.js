// The database itself must reject invalid states, even if application code has a bug.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createTestDatabase, dbSkip, sampleListing } from './helpers/db.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

describe('schema constraints (real Postgres)', { skip: dbSkip }, () => {
  let db;
  before(async () => { db = await createTestDatabase({ migrated: true }); });
  after(() => db?.drop());

  async function insert(overrides = {}, extraCols = {}) {
    const l = sampleListing(overrides);
    const cols = {
      seller_id: l.sellerId, title: l.title, description: l.description, price_vnd: l.priceVnd,
      category_id: l.categoryId, submission_key: l.submissionKey, request_hash: l.requestHash,
      dedup_key: l.dedupKey, ...extraCols,
    };
    const names = Object.keys(cols);
    const { rows } = await db.pool.query(
      `INSERT INTO listings (${names.join(', ')})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, status`,
      Object.values(cols),
    );
    return rows[0];
  }

  const rejects = (promise, code) => assert.rejects(promise, (err) => err.code === code);

  it('defaults a new listing to pending with a generated UUID', async () => {
    const row = await insert();
    assert.equal(row.status, 'pending');
    assert.match(row.id, /^[0-9a-f-]{36}$/);
  });

  it('rejects a reused submission key', async () => {
    await insert({ submissionKey: 'same-key' });
    await rejects(insert({ submissionKey: 'same-key' }), UNIQUE_VIOLATION);
  });

  it('rejects a status outside the API enum (e.g. draft, A9)', async () => {
    await rejects(insert({}, { status: 'draft' }), CHECK_VIOLATION);
  });

  it('rejects a negative price and an over-long title', async () => {
    await rejects(insert({ priceVnd: -1 }), CHECK_VIOLATION);
    await rejects(insert({ title: 'x'.repeat(201) }), CHECK_VIOLATION);
    await rejects(insert({ title: '' }), CHECK_VIOLATION);
  });

  it('rejects status and decision out of sync', async () => {
    const decision = JSON.stringify({ outcome: 'approved', reasons: [] });
    // pending with a decision
    await rejects(insert({}, { decision, decided_at: new Date() }), CHECK_VIOLATION);
    // decided without a decision
    await rejects(insert({}, { status: 'published' }), CHECK_VIOLATION);
    // decided with both → allowed
    const ok = await insert({}, { status: 'published', decision, decided_at: new Date() });
    assert.equal(ok.status, 'published');
  });

  it('rejects a running job without a lease', async () => {
    const { id } = await insert();
    await rejects(
      db.pool.query(`INSERT INTO moderation_jobs (listing_id, state) VALUES ($1, 'running')`, [id]),
      CHECK_VIOLATION,
    );
  });
});
