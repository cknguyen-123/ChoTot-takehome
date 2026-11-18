// The decision function for every rule combination in ASSUMPTIONS, using the
// real seed sellers and categories as fixtures (AGENTS.md §9).

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { decide } from '../src/moderation/decide.js';
import { loadSeed } from '../src/reference/seed.js';
import { compileBannedTerms } from '../src/rules/r1-banned-keywords.js';

let seed;
let bannedTerms;
before(async () => {
  seed = await loadSeed();
  bannedTerms = compileBannedTerms(seed.bannedKeywords);
});

const CLEAN = { title: 'iPhone 13 128GB', description: 'Used, good condition', price_vnd: 6_000_000 };
const BANNED = { title: 'iPhone 13 replica' };
const ODD_PRICE = { price_vnd: 100 };
const DUPLICATE = [{ id: 'original-id', status: 'published' }];

function run(sellerId, overrides = {}, duplicates = []) {
  const listing = { ...CLEAN, seller_id: sellerId, category_id: 'c-phones', ...overrides };
  return decide(listing, {
    seller: seed.sellers.get(sellerId),
    category: seed.categories.get('c-phones'),
    bannedTerms,
    earlierActiveDuplicates: duplicates,
  });
}

const rules = (decision) => decision.reasons.map((r) => r.rule_id);

describe('decide', () => {
  describe('ordinary verified seller (s-1002, trust 64)', () => {
    it('clean listing → approved and published, with a PASS reason (A10, A16)', () => {
      const d = run('s-1002');
      assert.equal(d.outcome, 'approved');
      assert.equal(d.status, 'published');
      assert.deepEqual(rules(d), ['PASS']);
    });
    it('banned term → rejected (R1)', () => {
      const d = run('s-1002', BANNED);
      assert.deepEqual([d.outcome, d.status, rules(d)], ['rejected', 'auto_rejected', ['R1']]);
    });
    it('duplicate → rejected (R3)', () => {
      assert.deepEqual(rules(run('s-1002', {}, DUPLICATE)), ['R3']);
      assert.equal(run('s-1002', {}, DUPLICATE).status, 'auto_rejected');
    });
    it('odd price → escalated (R2)', () => {
      const d = run('s-1002', ODD_PRICE);
      assert.deepEqual([d.outcome, d.status, rules(d)], ['escalated', 'needs_human', ['R2']]);
    });
  });

  describe('precedence between rules (A5)', () => {
    it('R1 beats R3 and R2, and only R1 is reported (A15)', () => {
      assert.deepEqual(rules(run('s-1002', { ...BANNED, ...ODD_PRICE }, DUPLICATE)), ['R1']);
    });
    it('R3 beats R2 and R5: rejection wins over escalation', () => {
      assert.deepEqual(rules(run('s-1004', ODD_PRICE, DUPLICATE)), ['R3']);
    });
    it('R2 and R5 together → escalated, both reported', () => {
      const d = run('s-1004', ODD_PRICE); // trust 70, unverified
      assert.equal(d.outcome, 'escalated');
      assert.deepEqual(rules(d), ['R2', 'R5']);
    });
    it('several banned terms → one R1 reason each', () => {
      assert.deepEqual(rules(run('s-1002', { title: 'stolen replica', description: 'fake' })), ['R1', 'R1', 'R1']);
    });
  });

  describe('trusted sellers (R4)', () => {
    it('s-1001 (92): odd price and duplicate are bypassed → approved with R4 (A2)', () => {
      const d = run('s-1001', ODD_PRICE, DUPLICATE);
      assert.deepEqual([d.outcome, d.status, rules(d)], ['approved', 'published', ['R4']]);
    });
    it('s-1001 (92): banned term still rejects (A1)', () => {
      assert.deepEqual(rules(run('s-1001', BANNED)), ['R1']);
    });
    it('s-1005 (88, unverified): approved, R5 not applied, and the reason says so (A6)', () => {
      const d = run('s-1005');
      assert.equal(d.outcome, 'approved');
      assert.deepEqual(rules(d), ['R4']);
      assert.match(d.reasons[0].message, /not verified/);
    });
    it('s-1005 with a banned term: rejected (A1 over A6)', () => {
      assert.deepEqual(rules(run('s-1005', BANNED)), ['R1']);
    });
    it('s-1006 (exactly 80) is trusted; s-1007 (79) is not', () => {
      assert.deepEqual(rules(run('s-1006', ODD_PRICE)), ['R4']);
      assert.deepEqual(rules(run('s-1007', ODD_PRICE)), ['R2']);
    });
  });

  describe('unverified sellers (R5)', () => {
    it('s-1008 (new, unverified): clean listing → escalated (R5)', () => {
      const d = run('s-1008');
      assert.deepEqual([d.outcome, d.status, rules(d)], ['escalated', 'needs_human', ['R5']]);
    });
    it('s-1008 with a banned term → rejected, not escalated', () => {
      assert.deepEqual(rules(run('s-1008', BANNED)), ['R1']);
    });
  });

  it('every reason has a rule_id and a non-empty message', () => {
    for (const d of [run('s-1002'), run('s-1004', ODD_PRICE), run('s-1005'), run('s-1002', BANNED)]) {
      for (const r of d.reasons) {
        assert.equal(typeof r.rule_id, 'string');
        assert.ok(r.message.length > 0);
      }
    }
  });

  it('is pure: same input, same output, input untouched', () => {
    const listing = { ...CLEAN, seller_id: 's-1004', category_id: 'c-phones', ...ODD_PRICE };
    const context = {
      seller: seed.sellers.get('s-1004'),
      category: seed.categories.get('c-phones'),
      bannedTerms,
      earlierActiveDuplicates: [],
    };
    const snapshot = JSON.stringify(listing);
    assert.deepEqual(decide(listing, context), decide(listing, context));
    assert.equal(JSON.stringify(listing), snapshot);
  });
});
