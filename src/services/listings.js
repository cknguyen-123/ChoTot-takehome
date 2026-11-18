// Listing use cases: submit, get, list. Owns the idempotency decision
// (202 / 200 / 409) and the 422 reference checks; all SQL is in the repository.
// Never evaluates moderation rules: POST only stores and enqueues (AGENTS.md §10).

import { createHash } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { findListingById, insertListingWithJob, listListings } from '../repositories/listings.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Fingerprint of the validated request. Built from the five fields in a fixed
 * order, so key order and whitespace in the JSON body do not matter.
 */
export function requestHash(l) {
  return sha256(JSON.stringify([l.sellerId, l.title, l.description, l.priceVnd, l.categoryId]));
}

/**
 * R3 comparison key (A3): same category and price, and the same title and
 * description ignoring case and leading/trailing whitespace. The seller is a
 * separate column. Used only for comparison; the listing is stored as sent (A14).
 */
export function dedupKey(l) {
  const norm = (s) => s.trim().toLowerCase();
  return sha256(JSON.stringify([norm(l.title), norm(l.description), l.categoryId, l.priceVnd]));
}

const iso = (date) => (date ? date.toISOString() : null);

/** Shapes a stored row as the API `Listing` schema. */
export function toApiListing(row) {
  return {
    id: row.id,
    seller_id: row.seller_id,
    title: row.title,
    description: row.description,
    price_vnd: row.price_vnd,
    category_id: row.category_id,
    status: row.status,
    created_at: iso(row.created_at),
    decided_at: iso(row.decided_at),
    decision: row.decision ?? null,
  };
}

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {{sellers: Map, categories: Map}} deps.seed
 * @param {object} [deps.logger]
 */
export function createListingService({ pool, seed, logger }) {
  return {
    /**
     * @param {string} submissionKey validated Idempotency-Key
     * @param {object} listing validated request (camelCase)
     * @returns {Promise<{httpStatus: 200|202, body: {id: string, status: string}}>}
     */
    async submit(submissionKey, listing) {
      // 422 before touching the database (ARCHITECTURE.md §5.1), so an unknown reference never
      // consumes the idempotency key.
      if (!seed.sellers.has(listing.sellerId)) {
        throw new AppError(422, 'unknown_seller', `Seller "${listing.sellerId}" does not exist`);
      }
      if (!seed.categories.has(listing.categoryId)) {
        throw new AppError(422, 'unknown_category', `Category "${listing.categoryId}" does not exist`);
      }

      const hash = requestHash(listing);
      const result = await insertListingWithJob(pool, {
        ...listing,
        submissionKey,
        requestHash: hash,
        dedupKey: dedupKey(listing),
      });
      const body = { id: result.listing.id, status: result.listing.status };

      if (result.created) {
        logger?.info('listing accepted', { listingId: body.id, sellerId: listing.sellerId });
        return { httpStatus: 202, body };
      }
      if (result.requestHash === hash) {
        // A replay reports the listing's current status (ARCHITECTURE.md §5.1).
        return { httpStatus: 200, body };
      }
      throw new AppError(
        409,
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request body',
      );
    },

    /** @returns {Promise<object|null>} API Listing, or null if not found. */
    async get(id) {
      const row = await findListingById(pool, id);
      return row ? toApiListing(row) : null;
    },

    async list(query) {
      return (await listListings(pool, query)).map(toApiListing);
    },
  };
}
