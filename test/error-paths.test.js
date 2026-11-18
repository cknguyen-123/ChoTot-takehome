// Error paths across all endpoints: nothing internal ever reaches the client
// (AGENTS.md §5: "Never leak stack traces or SQL"). No database needed: the pool
// points at a port where nothing listens, which is what an outage looks like.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { createLogger } from '../src/logger.js';
import { loadSeed } from '../src/reference/seed.js';
import { createListingService } from '../src/services/listings.js';
import { createReviewService } from '../src/services/review.js';
import { startTestServer } from './helpers/http.js';

const LEAK = /ECONNREFUSED|127\.0\.0\.1|postgres|SELECT|INSERT|UPDATE|stack|at \w+ \(|node_modules/i;

describe('error paths', () => {
  let server;
  let pool;
  const logged = [];

  before(async () => {
    pool = createPool({ connectionString: 'postgres://x:y@127.0.0.1:1/none' });
    const logger = createLogger({ write: (_lvl, line) => logged.push(JSON.parse(line)) });
    const seed = await loadSeed();
    server = await startTestServer(createApp({
      logger,
      listingService: createListingService({ pool, seed }),
      reviewService: createReviewService({ pool }),
    }));
  });
  after(async () => {
    await server?.close();
    await pool?.end();
  });

  async function call(method, path, body, headers = {}) {
    const res = await fetch(`${server.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  }

  describe('database unavailable → 500 internal_error, nothing leaked, details logged', () => {
    const listing = {
      seller_id: 's-1002', title: 't', description: '', price_vnd: 1, category_id: 'c-phones',
    };
    const cases = [
      ['POST /v1/listings', () => call('POST', '/v1/listings', listing, { 'idempotency-key': randomUUID() })],
      ['GET /v1/listings/{id}', () => call('GET', `/v1/listings/${randomUUID()}`)],
      ['GET /v1/listings', () => call('GET', '/v1/listings')],
      ['POST /v1/listings/{id}/decision', () => call('POST', `/v1/listings/${randomUUID()}/decision`, { decision: 'approve', moderator_id: 'm' })],
    ];
    for (const [name, request] of cases) {
      it(name, async () => {
        const before = logged.length;
        const { status, json, text } = await request();
        assert.equal(status, 500);
        assert.deepEqual(json, { error: { code: 'internal_error', message: 'An unexpected error occurred' } });
        assert.doesNotMatch(text, LEAK);
        const entry = logged.slice(before).find((l) => l.msg === 'unhandled error');
        assert.ok(entry, 'the real cause is logged for operators');
        assert.match(entry.err.message, /ECONNREFUSED|connect/);
      });
    }
  });

  it('validation still answers 400/422 without touching the database', async () => {
    assert.equal((await call('POST', '/v1/listings', { title: 1 }, { 'idempotency-key': 'k' })).status, 400);
    const unknownSeller = { seller_id: 's-0', title: 't', description: '', price_vnd: 1, category_id: 'c-phones' };
    assert.equal((await call('POST', '/v1/listings', unknownSeller, { 'idempotency-key': 'k' })).status, 422);
  });

  it('malformed percent-encoding in the path → 400 invalid_request, not 500', async () => {
    const res = await fetch(`${server.baseUrl}/v1/listings/%E0%A4%A`);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, 'invalid_request');
    assert.doesNotMatch(JSON.stringify(json), LEAK);
  });
});
