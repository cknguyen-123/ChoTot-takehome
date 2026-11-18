# ARCHITECTURE.md

How the Listing Moderation Service is laid out, and **why**. Business decisions
referenced here (A1, A2 …) live in `ASSUMPTIONS.md`. 

---

## 1. System overview

Moderation is **asynchronous**. `POST /v1/listings` only validates, stores the listing as
`pending` and records a moderation job, all in one transaction, then returns `202`. A
separate worker picks up the job, evaluates rules R1–R5 and commits **one** automated
result. Listings escalated to `needs_human` are resolved through the moderator endpoint.

```text
 Client / Moderator
        │  HTTP (openapi.yaml)
        ▼
┌──────────────────┐   one transaction: INSERT listing + INSERT job
│   API (Express)  │──────────────────────────────────────────┐
│  routes → services│                                          ▼
└──────────────────┘                                 ┌──────────────────┐
        ▲  reads listing + decision                  │    PostgreSQL     │
        └────────────────────────────────────────────│ listings          │
                                                     │ moderation_jobs   │
┌──────────────────┐  claim job (SKIP LOCKED+lease)  │ pgmigrations      │
│  Worker (Node)   │◄────────────────────────────────│                   │
│ rules → decide   │  commit result (conditional     └──────────────────┘
└──────────────────┘  UPDATE … WHERE status='pending')
```

### Listing lifecycle as implemented

```text
                     ┌──► auto_rejected                      (R1 / R3)
                     │
 POST ──► pending ───┼──► auto_approved ──► published ──► expired
                     │                        ▲
                     └──► needs_human ────────┤  POST /decision  approve
                                              └─► rejected       reject
```

- `draft` is a client-side state and is never stored (A9).
- An automated approval is published in the same transaction that commits it, so
  `auto_approved` is never a resting state (A10).
- Nothing sets `expired` yet (A11). If added, it is a periodic guarded update
  `WHERE status='published' AND …`, never a moderation phase.

## 2. Components and boundaries

| Component | Responsibility | Must not |
|-----------|----------------|----------|
| `routes/` | HTTP, request validation (spec limits), status codes, error shape `{error:{code,message}}` | contain business rules or SQL |
| `services/` | Use cases: submit, get, list, human decision, process job. Own transaction boundaries. | build HTTP responses |
| `rules/` | One pure function per rule: `(listing, context) → Reason[]` (empty when it does not fire) | do I/O |
| `moderation/decide` | Combine rule results into one outcome using the precedence in ASSUMPTIONS (A1, A2, A5, A6). **Only place precedence exists.** | do I/O |
| `repositories/` | All SQL, parameterised | make business decisions |
| `reference/` | Seed data (sellers, categories, banned keywords) loaded and validated at startup | change at runtime |
| `worker/` | Claim loop, lease renewal, retries, calling `services/processJob` | call the HTTP API |

Pure rules plus a single decision function mean every rule and every rule combination
can be unit-tested without a database or HTTP server.

## 3. Technology choices and reasoning

**PostgreSQL for both storage and the job queue.**
- The correctness guarantees (idempotency, one committed result per phase, one human
  winner) are all about **atomic, conditional writes**. Postgres gives us unique
  constraints, transactions and row locks, so these guarantees are enforced by the
  database rather than by application code that could race.
- Writing the listing and its job in **the same transaction** removes the dual-write
  problem (listing saved but job lost, or the reverse) that a separate broker would
  introduce.
- `SELECT … FOR UPDATE SKIP LOCKED` lets several workers share the queue safely.
- One dependency keeps `make run` well under the 180-second cold-start budget.
- Trade-off: a Postgres-backed queue has lower throughput than a dedicated broker. That
  is fine at this scale; see §9.

**Express on Node.js** — familiar, small, and enough for six endpoints.

**`pg` (node-postgres) with plain SQL, no ORM.** The guarantees in §6 depend on exact
statements (`INSERT … ON CONFLICT`, `UPDATE … WHERE status = 'pending'`,
`FOR UPDATE SKIP LOCKED`). Writing them by hand keeps them visible and reviewable; an
ORM would hide them and add build time. All SQL lives in `src/repositories/`.

**node-pg-migrate for schema migrations.** Migrations are plain SQL files with an up and
a down section, applied automatically at startup and recorded in `pgmigrations`. Chosen
over a small hand-written runner because this is built as a production service: a
maintained tool brings down-migrations for rollbacks, ordering checks, and handling of
statements that cannot run in a transaction, which a long-lived schema will need. It
takes a Postgres advisory lock (mode `wait`), so API and worker processes starting
together apply each migration exactly once. Trade-off: one more dependency, and it does
not detect edits to an already-applied file; the rule is "never edit, add a new one".

**API and worker as separate processes from the same image.** They scale and restart
independently, and restart behaviour (§7) is easy to reason about and test. The worker
loop can also be started in-process for integration tests.

**Seed data held in memory, read-only.** It is static, small, and needed on every
request (422 checks) and every evaluation. Each process loads and validates it at
startup and refuses to become ready if it is invalid.

## 4. Data model

The schema is defined in one place, the migration
[`src/db/migrations/1763424000000_init.sql`](src/db/migrations/1763424000000_init.sql).
In short:

| Table | Purpose | Key constraints |
|-------|---------|-----------------|
| `listings` | One row per accepted submission; `status` + `decision` are the committed moderation result | `UNIQUE (submission_key)` (A8); `status` limited to the API enum; title/description/price limits from the spec; **`decision_matches_status`**: `pending` ⇔ no decision and no `decided_at` |
| `moderation_jobs` | Durable job record per listing (state `queued → running → done`, or `failed`) | One job per listing (PK = `listing_id`); `running` requires `lease_until` |
| `pgmigrations` | Applied migrations (managed by node-pg-migrate) | — |

Indexes cover the list endpoint (newest first, by seller or status), the R3 lookup on
**active** listings only (partial index, A4), and the worker's claim queries.

`status` and `decision` are always written in the **same UPDATE**, so they cannot
disagree.

## 5. Request and processing flows

### 5.1 Submit — `POST /v1/listings`
1. Validate the `Idempotency-Key` header and the body (400), then check `seller_id` /
   `category_id` against seed data (422). This order (A16) means a rejected request
   never consumes its key.
2. In one transaction:
   `INSERT INTO listings … ON CONFLICT (submission_key) DO NOTHING RETURNING id`.
   - Inserted → also `INSERT INTO moderation_jobs`; respond **202** `{id, status}`.
   - Conflict → read the existing row; same `request_hash` → **200** with the stored
     `{id, status}`; different hash → **409**.
3. No rules are evaluated here (including R4, see A2).

The key comes from the required `Idempotency-Key` header; a request without it gets
`400` (A8).

### 5.2 Automated moderation — worker

Code: `src/worker.js` (process), `src/worker/loop.js` (polling loop),
`src/services/moderation.js` (one job), `src/repositories/jobs.js` (queue SQL).

1. **Claim** (one statement): pick one job that is `queued` with `run_after <= now()`,
   or `running` with `lease_until < now()` (its worker crashed), using
   `FOR UPDATE SKIP LOCKED` so concurrent workers never take the same row; set
   `state='running'`, `lease_until = now() + JOB_LEASE_MS`, `attempts = attempts + 1`.
   The new `attempts` value is the claim's **fencing token**: every later job write is
   `WHERE attempts = <mine> AND state = 'running'`, so a worker whose claim was taken
   over cannot change the job any more.
2. **Evaluate and commit**, in **one transaction**:
   - Load the listing; if it is no longer `pending`, mark the job done and stop.
   - Take `pg_advisory_xact_lock(1, hashtext(seller_id))`: R3 checks and commits for
     one seller run one at a time (released at COMMIT).
   - Load the seller's identical active listings that were already decided, or are
     pending and older (A4 refinement), then run `decide()` (pure).
   - `UPDATE listings SET status, decision, decided_at WHERE id = $1 AND status = 'pending'`.
     0 rows → another attempt or a moderator committed first; our result is discarded.
   - Mark the job `done`.
3. **Failure** (any error before COMMIT, which rolls everything back): attempt n is
   retried after `JOB_BACKOFF_BASE_MS × 2^(n-1)` (2, 4, 8, 16 s by default, capped at
   `JOB_BACKOFF_MAX_MS`). After `JOB_MAX_ATTEMPTS` (5) the job becomes `failed` with
   `last_error`. A crash during the last attempt also ends in `failed` instead of a
   sixth evaluation.
4. **Polling:** an idle loop asks again every `WORKER_POLL_INTERVAL_MS` (500 ms).
   `WORKER_CONCURRENCY` (2) loops run per process. On SIGTERM the worker stops claiming,
   finishes in-flight jobs and exits; a job cut off by a hard kill is reclaimed when its
   lease (30 s) expires.

Evaluating a listing takes milliseconds, so the lease is never renewed: a job still
running after 30 s is treated as abandoned. If it was only slow, the fencing token and
the `status='pending'` guard make its late result harmless.

### 5.3 Human resolution — `POST /v1/listings/{id}/decision`
Code: `src/services/review.js`, `commitHumanDecision` in `src/repositories/listings.js`.
The service records the moderator's choice; it decides nothing itself.

1. Validate the body (400, A24).
2. One statement: `UPDATE listings SET status = published|rejected, decision = …,
   decided_at = now(), decided_by = $moderator WHERE id = $1 AND status = 'needs_human'
   RETURNING …`. The new `decision` is built inside the same `UPDATE` from the row it
   replaces, so the escalation reasons are copied into the `HUMAN` reason's
   `detail.escalation_reasons` without a read-then-write gap (A23).
3. One row → **200** with the listing. Zero rows → look the listing up: missing → **404**,
   otherwise **409** (A25).

Concurrent requests: the first `UPDATE` takes the row lock; the others wait, then
re-check `status = 'needs_human'`, find it changed, and match 0 rows. Exactly one wins;
repeats get 409. A late automated attempt cannot overwrite the human result, because
its own guard requires `status = 'pending'`.

### 5.4 Read — `GET /v1/listings/{id}` and `GET /v1/listings`
Plain reads. `decision` is `null` while `pending`. The list endpoint filters by
`seller_id` and `status`, orders by `created_at DESC`, `limit` 1–100 (default 20).

## 6. How each guarantee is enforced

| Guarantee (brief) | Enforced by |
|-------------------|-------------|
| Idempotent submission under concurrent retries | `UNIQUE(submission_key)` + `INSERT … ON CONFLICT`; never select-then-insert |
| At most one committed automated result | `UPDATE … WHERE status='pending'`; losers see 0 rows and discard |
| Stale attempt never overwrites a result or a human decision | Same guard: once status left `pending`, no automated write can match |
| One winner among concurrent human decisions | `UPDATE … WHERE status='needs_human'` |
| Accepted work is not left unprocessed | Job written in the same transaction as the listing; lease expiry re-queues crashed claims; bounded retries with backoff |
| Two identical listings never both published, never both rejected (R3) | Per-seller advisory lock around check + commit; "decided first, then submitted first" tie-break (A4 refinement) |
| Failures reach an operator | Jobs end in `failed` with `last_error` and are logged at error level. In the current scope an operator finds them by querying `moderation_jobs` directly (A7). An admin API is deferred (§6.1). |
| Decisions are explainable | Each rule that decided the outcome adds a `Reason {rule_id, message, detail}` (A18); R1's message quotes the seed term (A20); approvals carry an R4 or `PASS` reason (A19) |

R1–R5 make no external writes, so there are no external side effects to retry.

### 6.1 Deferred: operator API for failed jobs (if time allows)

**Not in the current scope.** We will build it only if time remains after the
required API, the guarantees above and the tests are done.

- `GET /v1/admin/moderation-jobs?state=failed` — list failed jobs with `listing_id`,
  `attempts`, `last_error` and timestamps.
- `POST /v1/admin/moderation-jobs/{listing_id}/requeue` — reset a failed job to
  `queued` (`attempts = 0`, `run_after = now()`), guarded by `WHERE state='failed'`.

These would be additions to `openapi.yaml`, which the brief allows; existing contract
entries stay unchanged. Until then the same information comes from a SQL query, e.g.
`SELECT listing_id, attempts, last_error FROM moderation_jobs WHERE state='failed';`,
and re-queueing is a manual `UPDATE` (documented in README). The job table already
stores everything the API would expose, so adding it later needs no schema change.

## 7. Health probes

| Endpoint | Reports | Why |
|----------|---------|-----|
| `GET /livez` | `200 {"status":"ok"}` whenever the process can serve HTTP. **No dependency checks.** | A database outage must not make the orchestrator restart healthy API processes; restarting would not fix it. |
| `GET /readyz` | `200` only if every check passes, each within `READINESS_CHECK_TIMEOUT_MS` (2 s): `accepting_traffic` (not shutting down), `seed` (loaded and valid; the process does not start otherwise), `database` (answers `SELECT 1`), `migrations` (every migration file in this build is recorded in `pgmigrations`). Otherwise `503 {"status":"unavailable","checks":{…}}`; check names only, details go to the logs. | Traffic should only be routed to an instance that can actually do its job. |

Worker health is not part of the API probes. A stuck or failed backlog is reported
through job state (§6), not by taking the API out of rotation.

## 8. Restart behaviour and supported topology

| Event | What survives | What happens |
|-------|---------------|--------------|
| Worker restart / crash | Everything: listings, decisions, jobs | Jobs it held stay `running` until `lease_until` passes, then another (or the restarted) worker reclaims them. A result committed before the crash stays; a half-finished evaluation is simply redone. |
| API restart | Everything | Clients retry; idempotency returns the original listing. |
| Full restart (`make run` again) | Everything in the Postgres named volume | The worker resumes queued and expired jobs. |
| Volume removed (`make clean`) | Nothing | Fresh database; seed reloaded. |

**Supported topology:** one PostgreSQL primary; any number of API instances; any number
of worker instances. All coordination happens in Postgres, so adding instances needs no
configuration. `make run` starts one `db`, one `api` and one `worker`; the API is
published on host port `${PORT:-8080}`.

## 9. What I would change first for production

1. **Moderator authentication and audit.** `moderator_id` is currently trusted as sent.
   Add auth and an append-only decision history table.
2. **Reference data from the database**, with an admin path to update banned keywords,
   categories and sellers without redeploying.
3. **Operator tooling:** the deferred admin API in §6.1, with authentication.
4. **Metrics and alerts:** queue depth, oldest `queued` job age, `failed` count,
   decision latency, outcome rates per rule.
5. **Retention and expiry jobs**, and partitioning `listings` once volume grows.
6. **A dedicated broker** (e.g. SQS/Kafka with an outbox table) only if Postgres queue
   throughput becomes the bottleneck. The outbox keeps the "listing + job in one
   transaction" guarantee.
7. **Connection pooling** (PgBouncer) once API and worker instances multiply.
