import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateIdempotencyKey, validateListingRequest, validateListQuery } from '../src/http/validation.js';
import { dedupKey, requestHash } from '../src/services/listings.js';

const valid = () => ({
  seller_id: 's-1002',
  title: 'iPhone 13',
  description: 'Used',
  price_vnd: 6_000_000,
  category_id: 'c-phones',
});

const rejects400 = (fn, message) =>
  assert.throws(fn, (err) => err.status === 400 && err.code === 'invalid_request' && message.test(err.message));

describe('validateListingRequest', () => {
  it('accepts a valid body and returns camelCase fields', () => {
    assert.deepEqual(validateListingRequest(valid()), {
      sellerId: 's-1002', title: 'iPhone 13', description: 'Used', priceVnd: 6_000_000, categoryId: 'c-phones',
    });
  });

  for (const body of [null, [], 'text', 42]) {
    it(`rejects a non-object body (${JSON.stringify(body)})`, () => {
      rejects400(() => validateListingRequest(body), /JSON object/);
    });
  }

  it('rejects unknown fields and names them (A13)', () => {
    rejects400(() => validateListingRequest({ ...valid(), color: 'red', price: 1 }), /Unknown field\(s\): color, price/);
  });

  it('names every missing field', () => {
    rejects400(() => validateListingRequest({ title: 'x' }), /seller_id, description, price_vnd, category_id/);
  });

  describe('price_vnd', () => {
    for (const ok of [0, 1, Number.MAX_SAFE_INTEGER]) {
      it(`accepts ${ok}`, () => assert.equal(validateListingRequest({ ...valid(), price_vnd: ok }).priceVnd, ok));
    }
    for (const bad of ['1000', 12.5, -1, Number.MAX_SAFE_INTEGER + 1, null, true]) {
      it(`rejects ${JSON.stringify(bad)}`, () => {
        rejects400(() => validateListingRequest({ ...valid(), price_vnd: bad }), /price_vnd/);
      });
    }
  });

  describe('title and description limits', () => {
    it('accepts a 200-character title and a 5000-character description', () => {
      validateListingRequest({ ...valid(), title: 'x'.repeat(200), description: 'y'.repeat(5000) });
    });
    it('counts characters, not UTF-16 units (200 emoji is a valid title)', () => {
      validateListingRequest({ ...valid(), title: '😀'.repeat(200) });
    });
    it('rejects an empty or 201-character title', () => {
      rejects400(() => validateListingRequest({ ...valid(), title: '' }), /title/);
      rejects400(() => validateListingRequest({ ...valid(), title: 'x'.repeat(201) }), /title/);
    });
    it('rejects a 5001-character description, accepts an empty one', () => {
      rejects400(() => validateListingRequest({ ...valid(), description: 'y'.repeat(5001) }), /description/);
      assert.equal(validateListingRequest({ ...valid(), description: '' }).description, '');
    });
    it('keeps whitespace exactly as sent (A14)', () => {
      assert.equal(validateListingRequest({ ...valid(), title: '   ' }).title, '   ');
      assert.equal(validateListingRequest({ ...valid(), title: '  Phone ' }).title, '  Phone ');
    });
    it('rejects non-string ids', () => {
      rejects400(() => validateListingRequest({ ...valid(), seller_id: 1001 }), /seller_id/);
      rejects400(() => validateListingRequest({ ...valid(), category_id: null }), /category_id/);
    });
  });
});

describe('validateIdempotencyKey (A8)', () => {
  it('accepts printable ASCII up to 200 characters', () => {
    assert.equal(validateIdempotencyKey('abc-123'), 'abc-123');
    assert.equal(validateIdempotencyKey('k'.repeat(200)).length, 200);
  });
  it('rejects a missing, empty, too long or non-ASCII key', () => {
    rejects400(() => validateIdempotencyKey(undefined), /required/);
    for (const bad of ['', 'k'.repeat(201), 'khóa']) {
      rejects400(() => validateIdempotencyKey(bad), /printable/);
    }
  });
});

describe('validateListQuery', () => {
  it('defaults limit to 20', () => {
    assert.deepEqual(validateListQuery({}), { sellerId: undefined, status: undefined, limit: 20 });
  });
  it('accepts limit 1 and 100, rejects 0, 101 and non-integers', () => {
    assert.equal(validateListQuery({ limit: '1' }).limit, 1);
    assert.equal(validateListQuery({ limit: '100' }).limit, 100);
    for (const bad of ['0', '101', 'abc', '5.5', '-1', '']) {
      rejects400(() => validateListQuery({ limit: bad }), /limit/);
    }
  });
  it('rejects an unknown status and repeated parameters', () => {
    rejects400(() => validateListQuery({ status: 'draft' }), /status must be one of/);
    rejects400(() => validateListQuery({ status: ['pending', 'published'] }), /at most once/);
  });
});

describe('requestHash and dedupKey', () => {
  const l = validateListingRequest(valid());

  it('requestHash changes when any field changes', () => {
    assert.notEqual(requestHash(l), requestHash({ ...l, priceVnd: l.priceVnd + 1 }));
    assert.notEqual(requestHash(l), requestHash({ ...l, title: `${l.title} ` }));
  });

  it('dedupKey ignores case and surrounding whitespace (A3), not inner content', () => {
    assert.equal(dedupKey(l), dedupKey({ ...l, title: '  IPHONE 13 ', description: 'USED' }));
    assert.notEqual(dedupKey(l), dedupKey({ ...l, title: 'iPhone 14' }));
    assert.notEqual(dedupKey(l), dedupKey({ ...l, priceVnd: 1 }));
    assert.notEqual(dedupKey(l), dedupKey({ ...l, categoryId: 'c-laptops' }));
  });
});
