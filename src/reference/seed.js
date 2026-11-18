// Loads and validates the seed reference data (sellers, categories, banned
// keywords) once at startup. The files are read-only input: they are never
// modified, and invalid content stops the process instead of being "fixed".

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEED_DIR = fileURLToPath(new URL('../../seed/', import.meta.url));

async function readJson(dir, file) {
  const text = await readFile(join(dir, file), 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`seed/${file} is not valid JSON: ${err.message}`, { cause: err });
  }
}

function fail(file, index, problem) {
  throw new Error(`seed/${file}[${index}]: ${problem}`);
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

function validateSellers(list, file) {
  if (!Array.isArray(list)) throw new Error(`seed/${file} must be an array`);
  const byId = new Map();
  list.forEach((s, i) => {
    if (!isNonEmptyString(s?.id)) fail(file, i, 'id must be a non-empty string');
    if (!Number.isInteger(s.trust_score) || s.trust_score < 0 || s.trust_score > 100) {
      fail(file, i, 'trust_score must be an integer between 0 and 100');
    }
    if (typeof s.verified !== 'boolean') fail(file, i, 'verified must be a boolean');
    if (byId.has(s.id)) fail(file, i, `duplicate id "${s.id}"`);
    byId.set(s.id, Object.freeze({ id: s.id, name: s.name, trustScore: s.trust_score, verified: s.verified }));
  });
  return byId;
}

function validateCategories(list, file) {
  if (!Array.isArray(list)) throw new Error(`seed/${file} must be an array`);
  const byId = new Map();
  list.forEach((c, i) => {
    if (!isNonEmptyString(c?.id)) fail(file, i, 'id must be a non-empty string');
    // R2 compares against 3x and 1/3 of the median, so it must be a positive integer.
    if (!Number.isSafeInteger(c.median_price_vnd) || c.median_price_vnd <= 0) {
      fail(file, i, 'median_price_vnd must be a positive integer');
    }
    if (byId.has(c.id)) fail(file, i, `duplicate id "${c.id}"`);
    byId.set(c.id, Object.freeze({ id: c.id, name: c.name, medianPriceVnd: c.median_price_vnd }));
  });
  return byId;
}

function validateKeywords(list, file) {
  if (!Array.isArray(list)) throw new Error(`seed/${file} must be an array`);
  list.forEach((k, i) => {
    if (!isNonEmptyString(k)) fail(file, i, 'must be a non-empty string');
  });
  // Kept exactly as written (A12: no accent folding); matching is case-insensitive.
  return Object.freeze([...list]);
}

/**
 * @returns {Promise<Readonly<{sellers: Map, categories: Map, bannedKeywords: readonly string[]}>>}
 */
export async function loadSeed(dir = SEED_DIR) {
  const [sellers, categories, keywords] = await Promise.all([
    readJson(dir, 'sellers.json'),
    readJson(dir, 'categories.json'),
    readJson(dir, 'banned_keywords.json'),
  ]);
  return Object.freeze({
    sellers: validateSellers(sellers, 'sellers.json'),
    categories: validateCategories(categories, 'categories.json'),
    bannedKeywords: validateKeywords(keywords, 'banned_keywords.json'),
  });
}
