// /v1/listings over real HTTP against a real Postgres.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { silentLogger } from '../src/logger.js';
import { loadSeed } from '../src/reference/seed.js';
import { createListingService } from '../src/services/listings.js';
import { createTestDatabase, dbSkip } from './helpers/db.js';
import { startTestServer } from './helpers/http.js';

const body = (overrides = {}) => ({
  seller_id: 's-1002',
  title: 'iPhone 13 128GB',
  description: 'Used, good condition',
  price_vnd: 6_000_000,
  category_id: 'c-phones',
  ...overrides,
});

describe('/v1/listings (real Postgres)', { skip: dbSkip }, () => {
  let db;
  let server;
  let seed;

  before(async () => {
    db = await createTestDatabase({ migrated: true });
    seed = await loadSeed();
    const listingService = createListingService({ pool: db.pool, seed });
    server = await startTestServer(createApp({ logger: silentLogger, listingService }));
  });
  after(async () => {
    await server?.close();
    await db?.drop();
  });

  function submit(payload, { key = randomUUID(), raw } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (key !== null) headers['idempotency-key'] = key;
    return fetch(`${server.baseUrl}/v1/listings`, {
      method: 'POST',
      headers,
      body: raw ?? JSON.stringify(payload),
    });
  }
  const get = (path) => fetch(`${server.baseUrl}${path}`);

  async function expectError(res, status, code) {
    assert.equal(res.status, status);
    const json = await res.json();
    assert.equal(json.error.code, code);
    assert.equal(typeof json.error.message, 'string');
    return json;
  }

  describe('POST', () => {
    it('202 {id, status: pending} for a new submission', async () => {
      const res = await submit(body());
      assert.equal(res.status, 202);
      const json = await res.json();
      assert.deepEqual(Object.keys(json).sort(), ['id', 'status']);
      assert.equal(json.status, 'pending');
    });

    it('200 with the same id on a replay, even with keys in a different order', async () => {
      const key = randomUUID();
      const first = await (await submit(body(), { key })).json();
      const reordered = JSON.stringify(Object.fromEntries(Object.entries(body()).reverse()));
      const res = await submit(null, { key, raw: reordered });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), first);
    });

    it('409 when the key is reused with a different body; original unchanged', async () => {
      const key = randomUUID();
      const { id } = await (await submit(body(), { key })).json();
      await expectError(await submit(body({ price_vnd: 1 }), { key }), 409, 'idempotency_key_reused');
      assert.equal((await (await get(`/v1/listings/${id}`)).json()).price_vnd, 6_000_000);
    });

    it('20 concurrent identical submissions → one 202, nineteen 200, one id, one row', async () => {
      const key = randomUUID();
      const responses = await Promise.all(Array.from({ length: 20 }, () => submit(body(), { key })));
      const statuses = responses.map((r) => r.status).sort();
      assert.deepEqual(statuses, [...Array(19).fill(200), 202]);
      const ids = new Set(await Promise.all(responses.map(async (r) => (await r.json()).id)));
      assert.equal(ids.size, 1);
      const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM listings WHERE submission_key = $1', [key]);
      assert.equal(rows[0].n, 1);
    });

    it('stores a moderation job with each listing (nothing evaluated inline)', async () => {
      const { id } = await (await submit(body({ seller_id: 's-1001' }))).json();
      const listing = await (await get(`/v1/listings/${id}`)).json();
      assert.equal(listing.status, 'pending', 'R4 must not publish inline');
      const { rows } = await db.pool.query('SELECT state FROM moderation_jobs WHERE listing_id = $1', [id]);
      assert.deepEqual(rows, [{ state: 'queued' }]);
    });

    it('400 without an Idempotency-Key, and nothing is stored', async () => {
      const before = (await db.pool.query('SELECT count(*)::int AS n FROM listings')).rows[0].n;
      await expectError(await submit(body(), { key: null }), 400, 'invalid_request');
      const afterCount = (await db.pool.query('SELECT count(*)::int AS n FROM listings')).rows[0].n;
      assert.equal(afterCount, before);
    });

    it('400 for an unknown field (A13), a wrong type (A14) and a missing field', async () => {
      await expectError(await submit(body({ color: 'red' })), 400, 'invalid_request');
      await expectError(await submit(body({ price_vnd: '6000000' })), 400, 'invalid_request');
      const { title, ...noTitle } = body();
      await expectError(await submit(noTitle), 400, 'invalid_request');
    });

    it('400 for a non-JSON body or a JSON array', async () => {
      await expectError(await submit(null, { raw: '[]' }), 400, 'invalid_request');
      const res = await fetch(`${server.baseUrl}/v1/listings`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'idempotency-key': randomUUID() },
        body: 'hello',
      });
      await expectError(res, 400, 'invalid_request');
    });

    it('422 for an unknown seller or category', async () => {
      await expectError(await submit(body({ seller_id: 's-9999' })), 422, 'unknown_seller');
      await expectError(await submit(body({ category_id: 'c-boats' })), 422, 'unknown_category');
    });

    it('error precedence (A16): 400 before 422, 422 does not consume the key', async () => {
      await expectError(await submit(body({ seller_id: 's-9999', color: 'x' })), 400, 'invalid_request');
      const key = randomUUID();
      await expectError(await submit(body({ seller_id: 's-9999' }), { key }), 422, 'unknown_seller');
      assert.equal((await submit(body(), { key })).status, 202, 'key still free after a 422');
    });

    it('accepts every seed seller and category', async () => {
      for (const sellerId of seed.sellers.keys()) {
        assert.equal((await submit(body({ seller_id: sellerId }))).status, 202, sellerId);
      }
      for (const categoryId of seed.categories.keys()) {
        assert.equal((await submit(body({ category_id: categoryId }))).status, 202, categoryId);
      }
    });

    it('stores Vietnamese text and edge prices exactly as sent', async () => {
      const payload = body({ title: '  Xe máy Honda Wave  ', description: '', price_vnd: 0, category_id: 'c-motorbikes' });
      const { id } = await (await submit(payload)).json();
      const listing = await (await get(`/v1/listings/${id}`)).json();
      assert.equal(listing.title, '  Xe máy Honda Wave  ');
      assert.equal(listing.description, '');
      assert.equal(listing.price_vnd, 0);
    });
  });

  describe('GET /v1/listings/{id}', () => {
    it('200 with the full Listing; decision and decided_at null while pending', async () => {
      const { id } = await (await submit(body())).json();
      const res = await get(`/v1/listings/${id}`);
      assert.equal(res.status, 200);
      const listing = await res.json();
      assert.deepEqual(
        Object.keys(listing).sort(),
        ['category_id', 'created_at', 'decided_at', 'decision', 'description', 'id', 'price_vnd', 'seller_id', 'status', 'title'],
      );
      assert.equal(listing.decision, null);
      assert.equal(listing.decided_at, null);
      assert.ok(!Number.isNaN(Date.parse(listing.created_at)));
      assert.match(listing.created_at, /Z$/, 'UTC');
    });

    it('404 for an unknown id and for a malformed id', async () => {
      await expectError(await get(`/v1/listings/${randomUUID()}`), 404, 'not_found');
      await expectError(await get('/v1/listings/not-a-uuid'), 404, 'not_found');
    });
  });

  describe('GET /v1/listings', () => {
    it('newest first, filtered by seller and status, limited', async () => {
      // A seller id that only this test uses would fail the 422 check, so filter
      // by a dedicated seed seller and compare against what was just created.
      const ids = [];
      for (let i = 0; i < 3; i += 1) {
        ids.push((await (await submit(body({ seller_id: 's-1003', title: `Item ${i}` }))).json()).id);
      }
      const res = await get('/v1/listings?seller_id=s-1003&status=pending&limit=3');
      assert.equal(res.status, 200);
      const { items } = await res.json();
      assert.deepEqual(items.map((l) => l.id), [...ids].reverse());
      assert.ok(items.every((l) => l.seller_id === 's-1003' && l.status === 'pending'));
    });

    it('defaults to 20 items and accepts limit=100', async () => {
      assert.ok((await (await get('/v1/listings')).json()).items.length <= 20);
      assert.equal((await get('/v1/listings?limit=100')).status, 200);
    });

    it('empty list for a status with no listings', async () => {
      assert.deepEqual(await (await get('/v1/listings?status=expired')).json(), { items: [] });
    });

    it('400 for an invalid limit or status', async () => {
      await expectError(await get('/v1/listings?limit=0'), 400, 'invalid_request');
      await expectError(await get('/v1/listings?limit=101'), 400, 'invalid_request');
      await expectError(await get('/v1/listings?status=draft'), 400, 'invalid_request');
    });
  });
});
