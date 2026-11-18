// Each rule on its own, including the boundaries AGENTS.md §9 lists.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileBannedTerms, r1BannedKeywords } from '../src/rules/r1-banned-keywords.js';
import { r2PriceAnomaly } from '../src/rules/r2-price-anomaly.js';
import { r3Duplicate } from '../src/rules/r3-duplicate.js';
import { r4TrustedSeller } from '../src/rules/r4-trusted-seller.js';
import { r5UnverifiedSeller } from '../src/rules/r5-unverified-seller.js';

const SEED_TERMS = ['replica', 'fake', 'counterfeit', 'stolen', 'hang gia', 'hang nhai'];
const bannedTerms = compileBannedTerms(SEED_TERMS);
const r1 = (title, description = '') => r1BannedKeywords({ title, description }, { bannedTerms });
const matchedTerms = (reasons) => reasons.map((r) => r.detail.term);

describe('R1 banned keywords', () => {
  it('matches a whole word, case-insensitively', () => {
    for (const title of ['Rolex replica', 'REPLICA watch', 'Replica', 'a FaKe bag']) {
      assert.equal(r1(title).length, 1, title);
    }
  });

  it('puts the seed term verbatim in message (spec requirement)', () => {
    const [reason] = r1('Rolex REPLICA');
    assert.equal(reason.rule_id, 'R1');
    assert.equal(reason.message, 'title contains banned term "replica"');
    assert.deepEqual(reason.detail.matched, { title: 'REPLICA' });
  });

  it('does not match a term inside another word', () => {
    for (const title of ['replicas for sale', 'fakeness', 'unstolenable', 'counterfeiter', 'nofake']) {
      assert.deepEqual(r1(title), [], title);
    }
  });

  it('treats punctuation as a boundary', () => {
    for (const title of ['(fake)', 'fake!', 'fake,stolen', '"replica"', 'fake-ish', 'fake_item']) {
      assert.ok(r1(title).length >= 1, title);
    }
  });

  it('uses Unicode-aware boundaries (accented letters are part of a word)', () => {
    // With plain \b, "fake" would match here because \b treats "ế" as a non-word char.
    assert.deepEqual(r1('fakeế'), []);
    assert.deepEqual(r1('ếfake'), []);
    // Decomposed accent (e + combining circumflex): still part of the word.
    assert.deepEqual(r1('fakê'), []);
    assert.deepEqual(r1('fake2'), [], 'digits are word characters too');
  });

  it('matches multi-word terms, with any whitespace between the words (A21)', () => {
    for (const title of ['hang gia', 'Ban HANG GIA re', 'hang  gia', 'hang\ngia', 'hang\tnhai']) {
      assert.equal(r1(title).length, 1, JSON.stringify(title));
    }
    assert.deepEqual(r1('hanggia'), []);
    assert.deepEqual(r1('hang giare'), []);
  });

  it('does not fold accents: "hàng giả" does not match "hang gia" (A12)', () => {
    assert.deepEqual(r1('Túi hàng giả'), []);
    assert.deepEqual(r1('hàng nhái'), []);
  });

  it('checks the description too, and names both fields when both match (A20)', () => {
    assert.equal(r1('Nice bag', 'it is fake')[0].message, 'description contains banned term "fake"');
    assert.equal(r1('fake bag', 'totally fake')[0].message, 'title and description contain banned term "fake"');
  });

  it('gives one reason per matched term (A20)', () => {
    assert.deepEqual(matchedTerms(r1('stolen replica', 'fake')), ['replica', 'fake', 'stolen']);
  });

  it('keeps the seed spelling in message even if the seed uses capitals', () => {
    const terms = compileBannedTerms(['Hang Gia']);
    const [reason] = r1BannedKeywords({ title: 'hang gia', description: '' }, { bannedTerms: terms });
    assert.equal(reason.message, 'title contains banned term "Hang Gia"');
  });

  it('escapes regex characters in terms', () => {
    const terms = compileBannedTerms(['a.b']);
    assert.deepEqual(r1BannedKeywords({ title: 'axb', description: '' }, { bannedTerms: terms }), []);
    assert.equal(r1BannedKeywords({ title: 'a.b', description: '' }, { bannedTerms: terms }).length, 1);
  });
});

describe('R2 price anomaly', () => {
  const category = { id: 'c-phones', medianPriceVnd: 6_000_000 };
  const r2 = (price) => r2PriceAnomaly({ price_vnd: price }, { category });

  it('does not fire at exactly 3x or exactly one-third (A22)', () => {
    assert.deepEqual(r2(18_000_000), []);
    assert.deepEqual(r2(2_000_000), []);
    assert.deepEqual(r2(6_000_000), []);
  });

  it('fires just above 3x and just below one-third', () => {
    assert.equal(r2(18_000_001)[0].detail.direction, 'above');
    assert.equal(r2(1_999_999)[0].detail.direction, 'below');
  });

  it('fires for price 0 (A22)', () => {
    const [reason] = r2(0);
    assert.equal(reason.rule_id, 'R2');
    assert.equal(reason.message, 'price 0 VND is less than one-third of the c-phones median of 6,000,000 VND');
  });

  it('uses exact integer arithmetic when one-third is not a whole number', () => {
    // median 1000: one-third is 333.33…; 333 * 3 = 999 < 1000 fires, 334 does not.
    const cat = { id: 'c', medianPriceVnd: 1000 };
    assert.equal(r2PriceAnomaly({ price_vnd: 333 }, { category: cat }).length, 1);
    assert.deepEqual(r2PriceAnomaly({ price_vnd: 334 }, { category: cat }), []);
  });

  it('stays exact at the largest allowed price', () => {
    const [reason] = r2PriceAnomaly({ price_vnd: Number.MAX_SAFE_INTEGER }, { category });
    assert.equal(reason.detail.direction, 'above');
  });

  it('explains the bound in words a moderator can read', () => {
    assert.equal(
      r2(20_000_000)[0].message,
      'price 20,000,000 VND is more than 3 times the c-phones median of 6,000,000 VND',
    );
  });
});

describe('R3 duplicate', () => {
  const listing = { seller_id: 's-1002' };

  it('does not fire without an earlier active duplicate', () => {
    assert.deepEqual(r3Duplicate(listing, { earlierActiveDuplicates: [] }), []);
  });

  it('fires and names the original listing', () => {
    const [reason] = r3Duplicate(listing, {
      earlierActiveDuplicates: [{ id: 'aaaa', status: 'published' }, { id: 'bbbb', status: 'pending' }],
    });
    assert.equal(reason.rule_id, 'R3');
    assert.equal(reason.message, 'duplicate of listing aaaa (published) from the same seller');
    assert.equal(reason.detail.duplicate_of, 'aaaa');
  });
});

describe('R4 trusted seller', () => {
  const seller = (trustScore, verified = true) => ({ id: 's-x', trustScore, verified });

  it('fires at exactly 80 and above, not at 79', () => {
    assert.equal(r4TrustedSeller({}, { seller: seller(80) }).length, 1);
    assert.equal(r4TrustedSeller({}, { seller: seller(100) }).length, 1);
    assert.deepEqual(r4TrustedSeller({}, { seller: seller(79) }), []);
  });

  it('says when the trusted seller is unverified (A6)', () => {
    const [reason] = r4TrustedSeller({}, { seller: seller(88, false) });
    assert.match(reason.message, /not verified, but R5 does not apply/);
    assert.equal(reason.detail.verified, false);
    const [verified] = r4TrustedSeller({}, { seller: seller(88, true) });
    assert.doesNotMatch(verified.message, /verified/);
  });
});

describe('R5 unverified seller', () => {
  it('fires only for verified: false', () => {
    assert.equal(r5UnverifiedSeller({}, { seller: { id: 's-x', verified: false } })[0].message, 'seller s-x is not verified');
    assert.deepEqual(r5UnverifiedSeller({}, { seller: { id: 's-x', verified: true } }), []);
  });
});
