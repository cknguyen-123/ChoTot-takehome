-- Up Migration

-- init: listings and their moderation jobs.
-- Constraints live here, not only in code: the database is the last line of
-- defence against concurrent writers (AGENTS.md section 6).

CREATE TABLE listings (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id       text        NOT NULL,
  category_id     text        NOT NULL,
  title           text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description     text        NOT NULL CHECK (char_length(description) <= 5000),
  price_vnd       bigint      NOT NULL CHECK (price_vnd >= 0),
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending', 'auto_approved', 'auto_rejected', 'needs_human',
                    'published', 'rejected', 'expired')),
  -- {outcome, reasons[]}; written in the same UPDATE as status.
  decision        jsonb,
  decided_at      timestamptz,
  decided_by      text,       -- moderator_id for human decisions, NULL for automated
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Idempotency (A8): one listing per Idempotency-Key. The hash of the request
  -- body tells a replay (200) from a reused key with a different body (409).
  submission_key  text        NOT NULL UNIQUE,
  request_hash    text        NOT NULL,

  -- Normalised title/description/category/price used by R3 (A3).
  dedup_key       text        NOT NULL,

  -- A listing is either undecided (pending, no decision) or decided (both set).
  -- Makes "status and decision out of sync" impossible to store.
  CONSTRAINT decision_matches_status CHECK (
    (status =  'pending' AND decision IS NULL     AND decided_at IS NULL) OR
    (status <> 'pending' AND decision IS NOT NULL AND decided_at IS NOT NULL)
  )
);

-- GET /v1/listings: newest first, optionally filtered by seller and/or status.
CREATE INDEX listings_created_idx        ON listings (created_at DESC, id DESC);
CREATE INDEX listings_seller_created_idx ON listings (seller_id, created_at DESC, id DESC);
CREATE INDEX listings_status_created_idx ON listings (status, created_at DESC, id DESC);

-- R3: a seller's active listings with the same content (A3, A4).
CREATE INDEX listings_r3_idx ON listings (seller_id, dedup_key)
  WHERE status IN ('pending', 'auto_approved', 'needs_human', 'published');

CREATE TABLE moderation_jobs (
  listing_id   uuid        PRIMARY KEY REFERENCES listings (id) ON DELETE CASCADE,
  state        text        NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempts     integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after    timestamptz NOT NULL DEFAULT now(),
  lease_until  timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- A running job always has a lease, so a crashed worker's claim can expire.
  CONSTRAINT running_has_lease CHECK (state <> 'running' OR lease_until IS NOT NULL)
);

-- Worker claim queries: due queued jobs, and running jobs whose lease expired.
CREATE INDEX moderation_jobs_queued_idx  ON moderation_jobs (run_after)   WHERE state = 'queued';
CREATE INDEX moderation_jobs_running_idx ON moderation_jobs (lease_until) WHERE state = 'running';
-- Operators: SELECT … WHERE state = 'failed' (A7).
CREATE INDEX moderation_jobs_failed_idx  ON moderation_jobs (updated_at)  WHERE state = 'failed';

-- Down Migration

-- Drops everything the up migration created (jobs first: they reference listings).
DROP TABLE moderation_jobs;
DROP TABLE listings;
