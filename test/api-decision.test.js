// POST /v1/listings/{id}/decision over real HTTP against real Postgres.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { validateDecisionRequest } from '../src/http/validation.js';
import { silentLogger } from '../src/logger.js';
import { claimJob } from '../src/repositories/jobs.js';
import { loadSeed } from '../src/reference/seed.js';
import { createListingService } from '../src/services/listings.js';
import { createModerationService } from '../src/services/moderation.js';
import { createReviewService } from '../src/services/review.js';
import { createWorker } from '../src/worker/loop.js';
import { createTestDatabase, dbSkip } from './helpers/db.js';
import { startTestServer } from './helpers/http.js';

const SETTINGS = { concurrency: 1, pollIntervalMs: 10, leaseMs: 30_000, maxAttempts: 3, backoffBaseMs: 0, backoffMaxMs: 0 };

describe('validateDecisionRequest', () => {
  const ok = { decision: 'approve', moderator_id: 'm-1' };
  const rejects400 = (body, message) =>
    assert.throws(() => validateDecisionRequest(body), (e) => e.status === 400 && message.test(e.message));

  it('accepts approve/reject, with or without a note', () => {
    assert.deepEqual(validateDecisionRequest(ok), { decision: 'approve', moderatorId: 'm-1', note: undefined });
    assert.equal(validateDecisionRequest({ ...ok, decision: 'reject', note: 'spam' }).note, 'spam');
  });
  it('rejects anything else', () => {
    rejects400(null, /JSON object/);
    rejects400({ ...ok, decision: 'Approve' }, /decision/);
    rejects400({ ...ok, decision: 'approved' }, /decision/);
    rejects400({ decision: 'approve' }, /moderator_id/);
    rejects400({ ...ok, moderator_id: '' }, /moderator_id/);
    rejects400({ ...ok, moderator_id: 'm'.repeat(201) }, /moderator_id/);
    rejects400({ ...ok, note: null }, /note/);
    rejects400({ ...ok, note: 'n'.repeat(5001) }, /note/);
    rejects400({ ...ok, reason: 'x' }, /Unknown field\(s\): reason/);
  });
});

describe('POST /v1/listings/{id}/decision (real Postgres)', { skip: dbSkip }, () => {
  let db;
  let server;
  let listings;
  let moderation;

  before(async () => {
    db = await createTestDatabase({ migrated: true });
    const seed = await loadSeed();
    listings = createListingService({ pool: db.pool, seed });
    moderation = createModerationService({ pool: db.pool, seed, settings: SETTINGS, logger: silentLogger });
    const reviewService = createReviewService({ pool: db.pool });
    server = await startTestServer(createApp({ logger: silentLogger, listingService: listings, reviewService }));
  });
  after(async () => {
    await server?.close();
    await db?.drop();
  });
  beforeEach(() => db.pool.query('TRUNCATE listings CASCADE'));

  const worker = () => createWorker({ pool: db.pool, moderation, settings: SETTINGS, logger: silentLogger });
  async function drain() {
    const w = worker();
    while (await w.runOnce()) { /* empty the queue */ }
  }
  const submit = async (overrides = {}) =>
    (await listings.submit(randomUUID(), {
      sellerId: 's-1008', // unverified → needs_human (R5)
      title: 'Galaxy S21',
      description: 'New',
      priceVnd: 6_000_000,
      categoryId: 'c-phones',
      ...overrides,
    })).body.id;

  /** A listing the worker has escalated to needs_human. */
  async function escalated(overrides) {
    const id = await submit(overrides);
    await drain();
    assert.equal((await listings.get(id)).status, 'needs_human');
    return id;
  }

  const decide = (id, body) =>
    fetch(`${server.baseUrl}/v1/listings/${id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function expectError(res, status, code) {
    assert.equal(res.status, status);
    assert.equal((await res.json()).error.code, code);
  }

  it('approve → 200 with the full Listing, published, HUMAN reason keeps the escalation reasons', async () => {
    const id = await escalated();
    const before = await listings.get(id);
    const res = await decide(id, { decision: 'approve', moderator_id: 'm-1', note: 'checked ID by phone' });
    assert.equal(res.status, 200);
    const l = await res.json();
    assert.equal(l.id, id);
    assert.equal(l.status, 'published');
    assert.equal(l.decision.outcome, 'approved');
    assert.equal(l.decision.reasons.length, 1);
    const [reason] = l.decision.reasons;
    assert.equal(reason.rule_id, 'HUMAN');
    assert.equal(reason.message, 'approved by moderator m-1: checked ID by phone');
    assert.equal(reason.detail.moderator_id, 'm-1');
    assert.deepEqual(reason.detail.escalation_reasons.map((r) => r.rule_id), ['R5']);
    assert.ok(Date.parse(l.decided_at) >= Date.parse(before.decided_at), 'decided_at is the human decision time');
    assert.deepEqual(await listings.get(id), l, 'GET shows the same result');
  });

  it('reject → 200, status rejected, outcome rejected; note is optional', async () => {
    const id = await escalated({ sellerId: 's-1002', priceVnd: 100 }); // R2
    const res = await decide(id, { decision: 'reject', moderator_id: 'm-2' });
    assert.equal(res.status, 200);
    const l = await res.json();
    assert.equal(l.status, 'rejected');
    assert.equal(l.decision.outcome, 'rejected');
    assert.equal(l.decision.reasons[0].message, 'rejected by moderator m-2');
    assert.deepEqual(l.decision.reasons[0].detail.escalation_reasons.map((r) => r.rule_id), ['R2']);
  });

  it('10 moderators at once → exactly one 200, nine 409, and the winner is what is stored', async () => {
    const id = await escalated();
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      decide(id, { decision: i % 2 ? 'reject' : 'approve', moderator_id: `m-${i}` })));
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, ...Array(9).fill(409)]);

    const winner = await responses.find((r) => r.status === 200).json();
    const stored = await listings.get(id);
    assert.equal(stored.status, winner.status);
    assert.equal(stored.decision.reasons[0].detail.moderator_id, winner.decision.reasons[0].detail.moderator_id);
    for (const r of responses.filter((x) => x.status === 409)) {
      assert.equal((await r.json()).error.code, 'not_awaiting_review');
    }
  });

  it('a repeat of the winning request → 409 (no replay for decisions)', async () => {
    const id = await escalated();
    const body = { decision: 'approve', moderator_id: 'm-1' };
    assert.equal((await decide(id, body)).status, 200);
    await expectError(await decide(id, body), 409, 'not_awaiting_review');
  });

  it('409 for every status other than needs_human', async () => {
    const pending = await submit(); // not processed yet
    await expectError(await decide(pending, { decision: 'approve', moderator_id: 'm-1' }), 409, 'not_awaiting_review');

    const published = await submit({ sellerId: 's-1001' });
    const rejected = await submit({ sellerId: 's-1002', title: 'fake phone' });
    await drain();
    for (const id of [published, rejected]) {
      await expectError(await decide(id, { decision: 'reject', moderator_id: 'm-1' }), 409, 'not_awaiting_review');
    }
  });

  it('404 for an unknown or malformed id', async () => {
    const body = { decision: 'approve', moderator_id: 'm-1' };
    await expectError(await decide(randomUUID(), body), 404, 'not_found');
    await expectError(await decide('not-a-uuid', body), 404, 'not_found');
  });

  it('error order 400 → 404 → 409', async () => {
    await expectError(await decide(randomUUID(), { decision: 'maybe', moderator_id: 'm-1' }), 400, 'invalid_request');
    const published = await submit({ sellerId: 's-1001' });
    await drain();
    await expectError(await decide(published, { decision: 'approve', moderator_id: 'm-1', extra: 1 }), 400, 'invalid_request');
  });

  it('stale worker after a human decision → no overwrite (end to end)', async () => {
    const id = await submit();
    // Worker A claims with a short lease and stalls; worker B takes over and escalates.
    const stale = await claimJob(db.pool, { leaseMs: 100 });
    await new Promise((r) => setTimeout(r, 150));
    await drain();
    assert.equal((await listings.get(id)).status, 'needs_human');

    // A moderator approves; then worker A wakes up and finishes its old attempt.
    assert.equal((await decide(id, { decision: 'approve', moderator_id: 'm-1' })).status, 200);
    const late = await moderation.processJob(stale);
    assert.equal(late.committed, false);

    const l = await listings.get(id);
    assert.equal(l.status, 'published');
    assert.equal(l.decision.reasons[0].rule_id, 'HUMAN');
  });
});
