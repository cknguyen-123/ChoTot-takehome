import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { findListingById, insertListingWithJob, listListings } from '../src/repositories/listings.js';
import { createTestDatabase, dbSkip, sampleListing } from './helpers/db.js';

describe('listings repository (real Postgres)', { skip: dbSkip }, () => {
  let db;
  before(async () => { db = await createTestDatabase({ migrated: true }); });
  after(() => db?.drop());

  const jobsFor = async (id) =>
    (await db.pool.query('SELECT state, attempts FROM moderation_jobs WHERE listing_id = $1', [id])).rows;

  it('stores a pending listing and a queued job together', async () => {
    const result = await insertListingWithJob(db.pool, sampleListing());
    assert.equal(result.created, true);
    assert.equal(result.listing.status, 'pending');
    assert.equal(result.listing.decision, null);
    assert.equal(result.listing.price_vnd, 6_000_000, 'bigint comes back as a number');
    assert.deepEqual(await jobsFor(result.listing.id), [{ state: 'queued', attempts: 0 }]);
  });

  it('returns the existing listing and its hash when the key is reused', async () => {
    const first = await insertListingWithJob(db.pool, sampleListing({ submissionKey: 'k-replay' }));
    const again = await insertListingWithJob(
      db.pool,
      sampleListing({ submissionKey: 'k-replay', requestHash: 'hash-b', title: 'Different' }),
    );
    assert.equal(again.created, false);
    assert.equal(again.listing.id, first.listing.id);
    assert.equal(again.listing.title, first.listing.title, 'nothing is overwritten');
    assert.equal(again.requestHash, 'hash-a', 'caller compares this to decide 200 vs 409');
  });

  it('creates exactly one listing and one job under 20 concurrent submissions', async () => {
    const key = 'k-concurrent';
    const results = await Promise.all(
      Array.from({ length: 20 }, () => insertListingWithJob(db.pool, sampleListing({ submissionKey: key }))),
    );
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.listing.id)).size, 1);

    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS listings,
              (SELECT count(*)::int FROM moderation_jobs j JOIN listings l ON l.id = j.listing_id
                WHERE l.submission_key = $1) AS jobs
         FROM listings WHERE submission_key = $1`,
      [key],
    );
    assert.deepEqual(rows[0], { listings: 1, jobs: 1 });
  });

  it('finds a listing by id, and returns null for unknown or malformed ids', async () => {
    const { listing } = await insertListingWithJob(db.pool, sampleListing());
    assert.equal((await findListingById(db.pool, listing.id)).id, listing.id);
    assert.equal(await findListingById(db.pool, '00000000-0000-0000-0000-000000000000'), null);
    assert.equal(await findListingById(db.pool, 'not-a-uuid'), null);
  });

  it('lists newest first, with seller/status filters and a limit', async () => {
    const seller = 's-list-test';
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await insertListingWithJob(db.pool, sampleListing({ sellerId: seller }))).listing.id);
    }
    const all = await listListings(db.pool, { sellerId: seller, limit: 20 });
    assert.deepEqual(all.map((l) => l.id), [...ids].reverse());

    assert.equal((await listListings(db.pool, { sellerId: seller, limit: 2 })).length, 2);
    assert.equal((await listListings(db.pool, { sellerId: seller, status: 'published', limit: 20 })).length, 0);
    assert.equal((await listListings(db.pool, { sellerId: seller, status: 'pending', limit: 20 })).length, 3);
  });
});
