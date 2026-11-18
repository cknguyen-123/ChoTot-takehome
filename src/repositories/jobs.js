// All SQL for moderation_jobs: the durable queue (ARCHITECTURE.md §5.2).
//
// Fencing: every claim increments `attempts`, and every later write for that
// claim says `WHERE attempts = <my attempt> AND state = 'running'`. A worker
// whose lease expired and whose job was reclaimed by someone else therefore
// cannot change the job any more: its writes match 0 rows.

/**
 * Claims one due job: a queued job whose run_after has passed, or a running job
 * whose lease expired (its worker crashed or hung). SKIP LOCKED lets several
 * workers claim at once without waiting on, or double-claiming, the same row.
 * @returns {Promise<{listingId: string, attempt: number}|null>}
 */
export async function claimJob(pool, { leaseMs }) {
  const { rows } = await pool.query(
    `UPDATE moderation_jobs
        SET state = 'running',
            attempts = attempts + 1,
            lease_until = now() + make_interval(secs => $1::double precision / 1000),
            updated_at = now()
      WHERE listing_id = (
              SELECT listing_id FROM moderation_jobs
               WHERE (state = 'queued'  AND run_after   <= now())
                  OR (state = 'running' AND lease_until <  now())
               ORDER BY CASE WHEN state = 'queued' THEN run_after ELSE lease_until END
               LIMIT 1
               FOR UPDATE SKIP LOCKED)
      RETURNING listing_id, attempts`,
    [leaseMs],
  );
  if (rows.length === 0) return null;
  return { listingId: rows[0].listing_id, attempt: rows[0].attempts };
}

/** Marks the job done. Meant to run in the same transaction as the result commit. */
export async function completeJob(client, { listingId, attempt }) {
  const { rowCount } = await client.query(
    `UPDATE moderation_jobs
        SET state = 'done', lease_until = NULL, last_error = NULL, updated_at = now()
      WHERE listing_id = $1 AND attempts = $2 AND state = 'running'`,
    [listingId, attempt],
  );
  return rowCount === 1;
}

/** Puts the job back in the queue after a failed attempt. */
export async function rescheduleJob(pool, { listingId, attempt, delayMs, error }) {
  const { rowCount } = await pool.query(
    `UPDATE moderation_jobs
        SET state = 'queued',
            run_after = now() + make_interval(secs => $3::double precision / 1000),
            lease_until = NULL, last_error = $4, updated_at = now()
      WHERE listing_id = $1 AND attempts = $2 AND state = 'running'`,
    [listingId, attempt, delayMs, error],
  );
  return rowCount === 1;
}

/** Gives up on the job: state 'failed' with the last error, for an operator (A7). */
export async function failJob(pool, { listingId, attempt, error }) {
  const { rowCount } = await pool.query(
    `UPDATE moderation_jobs
        SET state = 'failed', lease_until = NULL, last_error = $3, updated_at = now()
      WHERE listing_id = $1 AND attempts = $2 AND state = 'running'`,
    [listingId, attempt, error],
  );
  return rowCount === 1;
}
