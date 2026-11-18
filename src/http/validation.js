// Request validation for the /v1/listings endpoints. Pure functions: each returns
// the validated value or throws AppError(400). Rules come from openapi.yaml plus
// ASSUMPTIONS A8 (Idempotency-Key), A13 (unknown fields), A14 (strict types),
// A15 (no trimming).

import { AppError } from './errors.js';

export const STATUSES = Object.freeze([
  'pending', 'auto_approved', 'auto_rejected', 'needs_human', 'published', 'rejected', 'expired',
]);

const LISTING_FIELDS = ['seller_id', 'title', 'description', 'price_vnd', 'category_id'];
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 5000;
// Printable ASCII, 1–200 characters (A8).
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7E]{1,200}$/;

function invalid(message) {
  return new AppError(400, 'invalid_request', message);
}

// Length in Unicode code points, as JSON Schema and Postgres char_length count it.
// ('😀'.length is 2 in JavaScript, but it is one character.)
const charLength = (s) => [...s].length;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A8: required header, 1–200 printable ASCII characters. */
export function validateIdempotencyKey(value) {
  if (value === undefined) {
    throw invalid('Idempotency-Key header is required');
  }
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw invalid('Idempotency-Key must be 1-200 printable ASCII characters');
  }
  return value;
}

/**
 * Validates a ListingRequest body. Returns a new object with exactly the five
 * fields, in camelCase.
 */
export function validateListingRequest(body) {
  if (!isPlainObject(body)) {
    throw invalid('Request body must be a JSON object');
  }

  // A13: fields the contract does not define are an error, not silently dropped.
  const unknown = Object.keys(body).filter((k) => !LISTING_FIELDS.includes(k));
  if (unknown.length) {
    throw invalid(`Unknown field(s): ${unknown.join(', ')}`);
  }

  const missing = LISTING_FIELDS.filter((k) => body[k] === undefined);
  if (missing.length) {
    throw invalid(`Missing required field(s): ${missing.join(', ')}`);
  }

  const { seller_id: sellerId, title, description, price_vnd: priceVnd, category_id: categoryId } = body;

  if (typeof sellerId !== 'string') throw invalid('seller_id must be a string');
  if (typeof categoryId !== 'string') throw invalid('category_id must be a string');

  // A15: validated and stored exactly as sent, no trimming.
  if (typeof title !== 'string' || charLength(title) < 1 || charLength(title) > TITLE_MAX) {
    throw invalid(`title must be a string of 1-${TITLE_MAX} characters`);
  }
  if (typeof description !== 'string' || charLength(description) > DESCRIPTION_MAX) {
    throw invalid(`description must be a string of at most ${DESCRIPTION_MAX} characters`);
  }

  // A14: an integer JSON number, no strings, no fractions; capped so it stays exact.
  if (typeof priceVnd !== 'number' || !Number.isSafeInteger(priceVnd) || priceVnd < 0) {
    throw invalid(`price_vnd must be an integer between 0 and ${Number.MAX_SAFE_INTEGER}`);
  }

  return { sellerId, title, description, priceVnd, categoryId };
}

// A repeated query parameter (?status=a&status=b) arrives as an array.
function singleQueryValue(query, name) {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`${name} must be given at most once`);
  return value;
}

/** GET /v1/listings query: seller_id, status, limit (1–100, default 20). */
export function validateListQuery(query = {}) {
  const sellerId = singleQueryValue(query, 'seller_id');
  const status = singleQueryValue(query, 'status');
  const limitRaw = singleQueryValue(query, 'limit');

  if (status !== undefined && !STATUSES.includes(status)) {
    throw invalid(`status must be one of ${STATUSES.join(', ')}`);
  }

  let limit = 20;
  if (limitRaw !== undefined) {
    limit = /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
    if (!(limit >= 1 && limit <= 100)) throw invalid('limit must be an integer between 1 and 100');
  }

  return { sellerId, status, limit };
}
