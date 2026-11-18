// The worker against real Postgres: one committed result per listing under
// races, crashes, stale attempts, retries and concurrent duplicates (AGENTS.md §6, §9).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { silentLogger } from '../src/logger.js';
import { claimJob } from '../src/repositories/jobs.js';
import { loadSeed } from '../src/reference/seed.js';
import { createListingService } from '../src/services/listings.js';
import { backoffMs, createModerationService } from '../src/services/moderation.js';
import { createWorker } from '../src/worker/loop.js';
import { createTestDatabase, dbSkip } from './helpers/db.js';

const SETTINGS = {
  concurrency: 2,
  pollIntervalMs: 10,
  leaseMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 0, // retry immediately in tests
  backoffMaxMs: 0,
};

const body = (overrides = {}) => ({
  sellerId: 's-1002',
  title: 'iPhone 13 128GB',
  description: 'Used, good condition',
  priceVnd: 6_000_000,
  categoryId: 'c-phones',
  ...overrides,
});

describe('backoffMs', () => {
  it('doubles from the base and is capped', () => {
    const s = { backoffBaseMs: 2_000, backoffMaxMs: 60_000 };
    assert.deepEqual([1, 2, 3, 4, 10].map((n) => backoffMs(n, s)), [2_000, 4_000, 8_000, 16_000, 60_000]);
  });
});

describe('worker (real Postgres)', { skip: dbSkip }, () => {
  let db;
  let seed;
  let listings;
  let moderation;

  before(async () => {
    db = await createTestDatabase({ migrated: true });
    seed = await loadSeed();
    listings = createListingService({ pool: db.pool, seed });
    moderation = createModerationService({ pool: db.pool, seed, settings: SETTINGS, logger: silentLogger });
  });
  after(() => db?.drop());

  // Each test starts with an empty queue so claims only see its own jobs.
  beforeEach(() => db.pool.query('TRUNCATE listings CASCADE'));

  const submit = async (overrides) => (await listings.submit(randomUUID(), body(overrides))).body.id;
  const listing = (id) => listings.get(id);
  const job = async (id) =>
    (await db.pool.query('SELECT state, attempts, last_error FROM moderation_jobs WHERE listing_id = $1', [id])).rows[0];
  const worker = (settings = SETTINGS, mod = moderation) =>
    createWorker({ pool: db.pool, moderation: mod, settings, logger: silentLogger });

  async function drain(w = worker()) {
    while (await w.runOnce()) { /* until the queue is empty */ }
  }

  describe('end to end: submit → worker → GET', () => {
    const cases = [
      ['s-1002', {}, 'published', 'approved', ['PASS']],
      ['s-1002', { title: 'Rolex replica' }, 'auto_rejected', 'rejected', ['R1']],
      ['s-1002', { priceVnd: 100 }, 'needs_human', 'escalated', ['R2']],
      ['s-1008', {}, 'needs_human', 'escalated', ['R5']],
      ['s-1001', { priceVnd: 100 }, 'published', 'approved', ['R4']],
      ['s-1005', {}, 'published', 'approved', ['R4']],
      ['s-1006', { priceVnd: 100 }, 'published', 'approved', ['R4']],
      ['s-1007', { priceVnd: 100 }, 'needs_human', 'escalated', ['R2']],
    ];
    for (const [seller, overrides, status, outcome, rules] of cases) {
      it(`${seller} ${JSON.stringify(overrides)} → ${status} (${rules})`, async () => {
        const id = await submit({ sellerId: seller, ...overrides });
        await drain();
        const l = await listing(id);
        assert.equal(l.status, status);
        assert.equal(l.decision.outcome, outcome);
        assert.deepEqual(l.decision.reasons.map((r) => r.rule_id), rules);
        assert.ok(l.decided_at, 'decided_at is set');
        assert.deepEqual(await job(id), { state: 'done', attempts: 1, last_error: null });
      });
    }

    it('R1 message contains the banned term verbatim (spec)', async () => {
      const id = await submit({ title: 'Rolex REPLICA' });
      await drain();
      assert.match((await listing(id)).decision.reasons[0].message, /"replica"/);
    });
  });

  it('20 listings, 4 concurrent workers → every listing decided exactly once', async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => submit({ title: `Item ${i}` })));
    const workers = Array.from({ length: 4 }, () => worker());
    await Promise.all(workers.map((w) => drain(w)));
    for (const id of ids) {
      assert.equal((await listing(id)).status, 'published');
      assert.deepEqual(await job(id), { state: 'done', attempts: 1, last_error: null });
    }
  });

  it('two workers racing on the same listing → exactly one commits', async () => {
    const id = await submit({ priceVnd: 100 });
    const claimA = await claimJob(db.pool, { leaseMs: 30_000 });
    // Both believe they hold the job (e.g. A is slow and B reclaimed it).
    const results = await Promise.all([moderation.processJob(claimA), moderation.processJob(claimA)]);
    assert.equal(results.filter((r) => r.committed).length, 1);
    assert.equal((await listing(id)).status, 'needs_human');
  });

  it('worker crash: lease expires, another worker reclaims and decides', async () => {
    const id = await submit();
    // "Crashed" worker: claims with a very short lease, then never finishes.
    const crashed = await claimJob(db.pool, { leaseMs: 100 });
    assert.equal(crashed.attempt, 1);
    assert.equal(await claimJob(db.pool, { leaseMs: 30_000 }), null, 'not reclaimable while leased');

    await new Promise((r) => setTimeout(r, 150));
    await drain();
    assert.equal((await listing(id)).status, 'published');
    assert.deepEqual(await job(id), { state: 'done', attempts: 2, last_error: null });

    // The crashed worker wakes up and finishes late: its result is discarded.
    const late = await moderation.processJob(crashed);
    assert.equal(late.committed, false);
    assert.deepEqual(await job(id), { state: 'done', attempts: 2, last_error: null });
  });

  it('stale worker after a human decision → no overwrite', async () => {
    const id = await submit({ priceVnd: 100 });
    const stale = await claimJob(db.pool, { leaseMs: 30_000 });
    // While it is slow, the listing is escalated and a moderator rejects it
    // (simulated directly; the human endpoint is Phase 6).
    const human = { outcome: 'rejected', reasons: [{ rule_id: 'HUMAN', message: 'rejected by m-1' }] };
    await db.pool.query(
      `UPDATE listings SET status = 'rejected', decision = $2, decided_at = now(), decided_by = 'm-1' WHERE id = $1`,
      [id, JSON.stringify(human)],
    );
    const result = await moderation.processJob(stale);
    assert.equal(result.committed, false);
    const l = await listing(id);
    assert.equal(l.status, 'rejected');
    assert.deepEqual(l.decision, human);
  });

  describe('failures', () => {
    it('retries, then marks the job failed with the error; listing stays pending (A7)', async () => {
      // A seed without the listing's seller makes every attempt fail.
      const brokenSeed = { ...seed, sellers: new Map() };
      const broken = createModerationService({ pool: db.pool, seed: brokenSeed, settings: SETTINGS, logger: silentLogger });
      const id = await submit();

      await drain(worker(SETTINGS, broken));
      assert.deepEqual(await job(id), { state: 'failed', attempts: 3, last_error: 'seller s-1002 not in seed data' });
      assert.equal((await listing(id)).status, 'pending');
      assert.equal(await claimJob(db.pool, { leaseMs: 30_000 }), null, 'failed jobs are not retried');
    });

    it('waits for the backoff before retrying', async () => {
      const brokenSeed = { ...seed, sellers: new Map() };
      const slow = { ...SETTINGS, backoffBaseMs: 60_000, backoffMaxMs: 60_000 };
      const broken = createModerationService({ pool: db.pool, seed: brokenSeed, settings: slow, logger: silentLogger });
      const id = await submit();
      await worker(slow, broken).runOnce();
      assert.equal((await job(id)).state, 'queued');
      assert.equal(await claimJob(db.pool, { leaseMs: 30_000 }), null, 'not due for 60 s');
    });

    it('a crash on the last attempt ends in failed, not an extra evaluation', async () => {
      const id = await submit();
      await db.pool.query(
        `UPDATE moderation_jobs SET state = 'running', attempts = 3, lease_until = now() - interval '1 second'
          WHERE listing_id = $1`,
        [id],
      );
      await drain();
      const j = await job(id);
      assert.equal(j.state, 'failed');
      assert.match(j.last_error, /did not finish/);
      assert.equal((await listing(id)).status, 'pending');
    });
  });

  describe('R3 duplicates under concurrency', () => {
    for (let round = 1; round <= 5; round += 1) {
      it(`two identical listings processed at once → one published, one rejected (round ${round})`, async () => {
        const [a, b] = [await submit(), await submit()];
        await Promise.all([worker().runOnce(), worker().runOnce()]);
        const statuses = [(await listing(a)).status, (await listing(b)).status];
        assert.deepEqual(statuses, ['published', 'auto_rejected'], 'the earlier one wins (A4)');
        const r3 = (await listing(b)).decision.reasons[0];
        assert.equal(r3.rule_id, 'R3');
        assert.equal(r3.detail.duplicate_of, a);
      });
    }

    it('five identical listings at once → exactly one published', async () => {
      const ids = [];
      for (let i = 0; i < 5; i += 1) ids.push(await submit());
      await Promise.all(Array.from({ length: 5 }, () => drain()));
      const statuses = await Promise.all(ids.map(async (id) => (await listing(id)).status));
      assert.equal(statuses.filter((s) => s === 'published').length, 1);
      assert.equal(statuses.filter((s) => s === 'auto_rejected').length, 4);
    });

    it('a listing decided first wins even if it was submitted later (A4 refinement)', async () => {
      // B is created first but becomes visible late (its transaction committed
      // after A was already decided): simulated by back-dating B.
      const a = await submit();
      await drain();
      assert.equal((await listing(a)).status, 'published');
      const b = await submit();
      await db.pool.query(`UPDATE listings SET created_at = now() - interval '1 minute' WHERE id = $1`, [b]);
      await drain();
      assert.equal((await listing(b)).status, 'auto_rejected');
      assert.equal((await listing(b)).decision.reasons[0].detail.duplicate_of, a);
    });

    it('the seller lock makes a check wait for an in-flight commit (no double approval)', async () => {
      // A is being committed as published by another worker (transaction still
      // open, holding the seller lock). B is older, so without the lock B would
      // see A as "pending and later", ignore it, and be published too.
      const a = await submit();
      const b = await submit();
      await db.pool.query(`UPDATE listings SET created_at = now() - interval '1 minute' WHERE id = $1`, [b]);
      await db.pool.query(`UPDATE moderation_jobs SET state = 'done' WHERE listing_id = $1`, [a]);

      const otherWorker = await db.pool.connect();
      try {
        await otherWorker.query('BEGIN');
        await otherWorker.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', ['s-1002']);
        await otherWorker.query(
          `UPDATE listings SET status = 'published', decided_at = now(),
                  decision = '{"outcome":"approved","reasons":[]}' WHERE id = $1`,
          [a],
        );

        const processingB = worker().runOnce();
        await new Promise((r) => setTimeout(r, 200));
        assert.equal((await listing(b)).status, 'pending', 'B waits for the seller lock');

        await otherWorker.query('COMMIT');
        await processingB;
      } finally {
        otherWorker.release();
      }
      const decidedB = await listing(b);
      assert.equal(decidedB.status, 'auto_rejected');
      assert.equal(decidedB.decision.reasons[0].detail.duplicate_of, a);
    });

    it('a rejected or case-different listing does not block, but a case-different duplicate does (A3)', async () => {
      const banned = await submit({ title: 'fake iPhone' });
      await drain();
      assert.equal((await listing(banned)).status, 'auto_rejected');
      const again = await submit({ title: 'fake iPhone' }); // same content, original rejected → not active
      await drain();
      assert.equal((await listing(again)).decision.reasons[0].rule_id, 'R1', 'rejected by R1, not R3');

      const first = await submit();
      await drain();
      const shouted = await submit({ title: '  IPHONE 13 128GB ' });
      await drain();
      assert.equal((await listing(first)).status, 'published');
      assert.equal((await listing(shouted)).decision.reasons[0].rule_id, 'R3');
    });

    it('trusted sellers bypass R3: both identical listings are published (A2)', async () => {
      const [a, b] = [await submit({ sellerId: 's-1001' }), await submit({ sellerId: 's-1001' })];
      await drain();
      assert.deepEqual([(await listing(a)).status, (await listing(b)).status], ['published', 'published']);
    });
  });

  it('start/stop: background loops process jobs and stop promptly', async () => {
    const id = await submit();
    const w = worker({ ...SETTINGS, pollIntervalMs: 50 });
    w.start();
    for (let i = 0; i < 100 && (await listing(id)).status === 'pending'; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const started = Date.now();
    await w.stop();
    assert.ok(Date.now() - started < 500, 'stop() does not wait out a poll interval');
    assert.equal((await listing(id)).status, 'published');
  });
});
