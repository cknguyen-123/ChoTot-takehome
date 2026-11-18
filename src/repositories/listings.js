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

const ACTIVE_STATUSES = ['pending', 'auto_approved', 'needs_human', 'published']; // A4

/** Listing as the worker needs it, including the R3 dedup key. */
export async function findListingForModeration(client, id) {
  const { rows } = await client.query(
    `SELECT ${LISTING_COLUMNS}, dedup_key FROM listings WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Takes a transaction-scoped lock for one seller, so R3 checks and commits for
 * the same seller run one at a time. Released automatically at COMMIT/ROLLBACK.
 * (Two-key form: namespace 1 = "R3 per seller", then a hash of the seller id.)
 */
export async function lockSellerForDuplicateCheck(client, sellerId) {
  await client.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [sellerId]);
}

/**
 * The active listings this one counts as a duplicate of (A3, A4 as refined):
 * same seller and dedup key, active, and either
 *   - already decided (needs_human / published / auto_approved): it got there first, or
 *   - still pending but submitted earlier (created_at, then id).
 * Must be called while holding lockSellerForDuplicateCheck.
 * @returns {Promise<Array<{id: string, status: string}>>} original first
 */
export async function findEarlierActiveDuplicates(client, listing) {
  const { rows } = await client.query(
    `SELECT id, status FROM listings
      WHERE seller_id = $1 AND dedup_key = $2 AND id <> $3
        AND status = ANY($5::text[])
        AND (status <> 'pending' OR (created_at, id) < ($4, $3))
      ORDER BY (status = 'pending'), created_at, id`,
    [listing.seller_id, listing.dedup_key, listing.id, listing.created_at, ACTIVE_STATUSES],
  );
  return rows;
}

/**
 * Commits the one automated result. Status and decision are written in the
 * same statement, and only if the listing is still pending: a stale or
 * duplicate attempt, or one racing a human decision, matches 0 rows and must
 * discard its result (AGENTS.md §6.2, §6.3).
 * @returns {Promise<boolean>} true if this call committed the result
 */
export async function commitAutomatedDecision(client, { id, status, decision }) {
  const { rowCount } = await client.query(
    `UPDATE listings SET status = $2, decision = $3, decided_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [id, status, JSON.stringify(decision)],
  );
  return rowCount === 1;
}

/**
 * Commits the one human result (AGENTS.md §6.4). Only a listing still in
 * needs_human matches, so among concurrent or repeated requests exactly one
 * changes the row; the rest get null and the caller answers 404 or 409.
 *
 * The new decision is built inside the same UPDATE from the row being
 * replaced: the escalation reasons are copied into the human reason's
 * detail.escalation_reasons (A23). No read-then-write gap.
 *
 * @param {{id: string, status: 'published'|'rejected', outcome: 'approved'|'rejected',
 *          reason: {rule_id: string, message: string, detail: object}, moderatorId: string}} d
 * @returns {Promise<object|null>} the updated listing, or null if nothing changed
 */
export async function commitHumanDecision(pool, d) {
  if (typeof d.id !== 'string' || !UUID_PATTERN.test(d.id)) return null;
  const { rows } = await pool.query(
    `UPDATE listings
        SET status = $2,
            decision = jsonb_build_object(
              'outcome', $3::text,
              'reasons', jsonb_build_array(
                jsonb_set($4::jsonb, '{detail,escalation_reasons}',
                          COALESCE(decision->'reasons', '[]'::jsonb)))),
            decided_at = now(),
            decided_by = $5
      WHERE id = $1 AND status = 'needs_human'
      RETURNING ${LISTING_COLUMNS}`,
    [d.id, d.status, d.outcome, JSON.stringify(d.reason), d.moderatorId],
  );
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
