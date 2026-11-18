// All SQL for listings. No business decisions here: callers pass in the values
// to store (including request_hash and dedup_key) and decide what results mean.

import { withTransaction } from '../db/pool.js';

// Columns returned to callers. Internal bookkeeping (submission_key, hashes) is
// only returned where a caller needs it.
const LISTING_COLUMNS = `
  id, seller_id, title, description, price_vnd, category_id,
  status, decision, decided_at, decided_by, created_at`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stores a new listing as `pending` together with its moderation job, in one
 * transaction (no listing without a job, no job without a listing).
 *
 * Idempotent under concurrency: INSERT … ON CONFLICT on the unique
 * submission_key. If the key already exists, nothing is written and the existing
 * listing is returned with its request_hash so the caller can tell a replay
 * (same hash → 200) from a reused key (different hash → 409). Never
 * "SELECT, then INSERT if missing": that races.
 *
 * @returns {Promise<{created: boolean, listing: object, requestHash: string}>}
 */
export async function insertListingWithJob(pool, l) {
  return withTransaction(pool, async (client) => {
    const inserted = await client.query(
      `INSERT INTO listings
         (seller_id, title, description, price_vnd, category_id,
          submission_key, request_hash, dedup_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (submission_key) DO NOTHING
       RETURNING ${LISTING_COLUMNS}, request_hash`,
      [l.sellerId, l.title, l.description, l.priceVnd, l.categoryId,
        l.submissionKey, l.requestHash, l.dedupKey],
    );

    if (inserted.rowCount === 1) {
      const { request_hash: requestHash, ...listing } = inserted.rows[0];
      await client.query('INSERT INTO moderation_jobs (listing_id) VALUES ($1)', [listing.id]);
      return { created: true, listing, requestHash };
    }

    // Key already used. If a concurrent request inserted it, ON CONFLICT waited
    // for that transaction to commit, so this read sees the row.
    const existing = await client.query(
      `SELECT ${LISTING_COLUMNS}, request_hash FROM listings WHERE submission_key = $1`,
      [l.submissionKey],
    );
    const { request_hash: requestHash, ...listing } = existing.rows[0];
    return { created: false, listing, requestHash };
  });
}

/** @returns {Promise<object|null>} null when no listing has this id. */
export async function findListingById(pool, id) {
  // Not a UUID → cannot exist. Checking here avoids a Postgres type error (500).
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return null;
  const { rows } = await pool.query(`SELECT ${LISTING_COLUMNS} FROM listings WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Newest first; optional filters. `limit` is validated by the caller (1–100).
 * Ties on created_at are broken by id so the order is stable.
 */
export async function listListings(pool, { sellerId, status, limit }) {
  const { rows } = await pool.query(
    `SELECT ${LISTING_COLUMNS} FROM listings
      WHERE ($1::text IS NULL OR seller_id = $1)
        AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [sellerId ?? null, status ?? null, limit],
  );
  return rows;
}
