# ARCHITECTURE.md

How the Listing Moderation Service is laid out, and **why**. Business decisions
referenced here (A1, A2 …) live in `ASSUMPTIONS.md`. Items marked **OPEN** depend on a
decision that has not been taken yet.

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
┌──────────────────┐  claim job (SKIP LOCKED+lease)  │ schema_migrations │
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

- `draft` from the brief is not in the API `Status` enum and is not used (**OPEN**,
  ASSUMPTIONS).
- When `auto_approved` becomes `published` (same transaction vs. a later step) is **OPEN**
  (A2). The design supports both: publishing is a guarded update
  `WHERE status='auto_approved'`.
- `expired` exists in the enum; what triggers it is **OPEN**. If implemented, it is a
  periodic guarded update `WHERE status='published' AND …`, never a moderation phase.

## 2. Components and boundaries

| Component | Responsibility | Must not |
|-----------|----------------|----------|
| `routes/` | HTTP, request validation (spec limits), status codes, error shape `{error:{code,message}}` | contain business rules or SQL |
| `services/` | Use cases: submit, get, list, human decision, process job. Own transaction boundaries. | build HTTP responses |
| `rules/` | One pure function per rule: `(listing, context) → Reason \| null` | do I/O |
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

**API and worker as separate processes from the same image.** They scale and restart
independently, and restart behaviour (§7) is easy to reason about and test. The worker
loop can also be started in-process for integration tests.

**Seed data held in memory, read-only.** It is static, small, and needed on every
request (422 checks) and every evaluation. Each process loads and validates it at
startup and refuses to become ready if it is invalid.

## 4. Data model (sketch)

```sql
listings (
  id               uuid primary key,
  seller_id        text   not null,
  title            text   not null,
  description      text   not null,
  price_vnd        bigint not null check (price_vnd >= 0),
  category_id      text   not null,
  status           text   not null,            -- API Status enum, check constraint
  decision         jsonb,                       -- {outcome, reasons[]}; null while pending
  decided_at       timestamptz,
  decided_by       text,                        -- moderator_id for human decisions
  created_at       timestamptz not null default now(),
  submission_key   text unique,                 -- idempotency key (transport: OPEN)
  request_hash     text,                        -- hash of normalised body → 200 vs 409
  dedup_key        text                         -- normalised fields for R3 (A3)
)
-- index (seller_id, dedup_key) for R3; index (created_at desc) for the list endpoint

moderation_jobs (
  listing_id   uuid primary key references listings(id),
  state        text not null,          -- queued | running | done | failed
  attempts     int  not null default 0,
  run_after    timestamptz not null default now(),
  lease_until  timestamptz,
  last_error   text
)
```

`status` and `decision` are always written in the **same UPDATE**, so they cannot
disagree.

## 5. Request and processing flows

### 5.1 Submit — `POST /v1/listings`
1. Validate body (400) and check `seller_id` / `category_id` against seed data (422).
2. In one transaction:
   `INSERT INTO listings … ON CONFLICT (submission_key) DO NOTHING RETURNING id`.
   - Inserted → also `INSERT INTO moderation_jobs`; respond **202** `{id, status}`.
   - Conflict → read the existing row; same `request_hash` → **200** with the stored
     `{id, status}`; different hash → **409**.
3. No rules are evaluated here (including R4, see A2).

How the key is supplied (header name, required or optional, behaviour without a key) is
**OPEN** in ASSUMPTIONS. The mechanism above does not change whatever is chosen.

### 5.2 Automated moderation — worker
1. **Claim:** in a short transaction, select one job where
   `state='queued' AND run_after <= now()`, or `state='running' AND lease_until < now()`
   (crashed worker), `FOR UPDATE SKIP LOCKED`; set `state='running'`,
   `lease_until = now() + lease`, `attempts = attempts + 1`.
2. **Evaluate:** load the listing (skip if no longer `pending`), seller, category median
   and the seller's other active listings; run rules; `decide` → outcome + reasons.
3. **Commit:** in one transaction:
   - Take `pg_advisory_xact_lock(seller_id)` so R3 checks for the same seller are
     serialised (two identical listings cannot approve each other or reject each other;
     tie-break per A4).
   - `UPDATE listings SET status=…, decision=…, decided_at=now()
      WHERE id=$1 AND status='pending'`.
   - Mark the job `done` whether the update matched 1 row (we won) or 0 rows (another
     attempt already committed; our result is discarded).
4. **Failure before commit:** set `state='queued'`, `run_after = now() + backoff`,
   store `last_error`. After `MAX_ATTEMPTS`, set `state='failed'` (see §6).

### 5.3 Human resolution — `POST /v1/listings/{id}/decision`
`UPDATE listings SET status = published|rejected, decision = …, decided_at = now(),
decided_by = $moderator WHERE id = $1 AND status = 'needs_human' RETURNING *`.
One row → **200** with the listing. Zero rows → 404 if the listing does not exist,
otherwise **409**. Concurrent requests: the row lock lets exactly one win.

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
| Failures reach an operator | Jobs end in `failed` with `last_error` and are logged at error level. In the current scope an operator finds them by querying `moderation_jobs` directly (A7). An admin API is deferred (§6.1). |
| Decisions are explainable | Every fired rule adds a `Reason {rule_id, message, detail}`; R1's message contains the matched term; approvals carry reasons too |

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
| `GET /readyz` | `200` only if: seed data loaded and valid, DB answers `SELECT 1` within a short timeout, migrations are at the expected version. Otherwise `503 {"status":"unavailable", "checks":{…}}`. | Traffic should only be routed to an instance that can actually do its job. |

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
