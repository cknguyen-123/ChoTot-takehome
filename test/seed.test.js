import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadSeed } from '../src/reference/seed.js';

const VALID = {
  'sellers.json': [{ id: 's-1', name: 'A', trust_score: 80, verified: true }],
  'categories.json': [{ id: 'c-1', name: 'C', median_price_vnd: 1000 }],
  'banned_keywords.json': ['fake'],
};

async function seedDir(overrides) {
  const dir = await mkdtemp(join(tmpdir(), 'seed-'));
  for (const [file, content] of Object.entries({ ...VALID, ...overrides })) {
    await writeFile(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

describe('loadSeed', () => {
  it('loads the real seed files with the fixtures the tests rely on', async () => {
    const seed = await loadSeed();
    assert.equal(seed.sellers.get('s-1006').trustScore, 80);
    assert.equal(seed.sellers.get('s-1007').trustScore, 79);
    assert.equal(seed.sellers.get('s-1005').verified, false);
    assert.equal(seed.categories.get('c-phones').medianPriceVnd, 6_000_000);
    assert.ok(seed.bannedKeywords.includes('hang gia'));
  });

  it('keeps keywords exactly as written (A12)', async () => {
    const dir = await seedDir({ 'banned_keywords.json': ['Hang Gia'] });
    try {
      assert.deepEqual([...(await loadSeed(dir)).bannedKeywords], ['Hang Gia']);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  const invalid = [
    ['broken JSON', { 'sellers.json': '[{' }, /not valid JSON/],
    ['non-boolean verified', { 'sellers.json': [{ id: 's', trust_score: 1, verified: 'no' }] }, /verified/],
    ['trust score out of range', { 'sellers.json': [{ id: 's', trust_score: 101, verified: true }] }, /trust_score/],
    ['duplicate seller', { 'sellers.json': [VALID['sellers.json'][0], VALID['sellers.json'][0]] }, /duplicate/],
    ['zero median', { 'categories.json': [{ id: 'c', median_price_vnd: 0 }] }, /median_price_vnd/],
    ['empty keyword', { 'banned_keywords.json': [''] }, /non-empty/],
  ];
  for (const [label, files, message] of invalid) {
    it(`refuses to start with ${label}`, async () => {
      const dir = await seedDir(files);
      try {
        await assert.rejects(loadSeed(dir), message);
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  }
});
