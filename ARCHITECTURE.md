# ARCHITECTURE.md

How the Listing Moderation Service is laid out, and **why**. Business decisions
referenced here (A1, A2 …) live in `ASSUMPTIONS.md`.
| Section |
|--------------------|---------|
| How the system is laid out | §1 Overview, §5 Flows |
| Why | §3 (each choice with its reason, alternatives and cost), and the "why" column of §2 |
| Where the boundaries are, and what is behind each one | §2 Boundaries |
| Storage / messaging choice and reasoning | §3 |
| What `/livez` and `/readyz` report | §7 |
| What survives a worker restart and a full restart; supported topology | §8 |
| What I would change first for production | §9 |

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

## 2. Boundaries, and what is behind each one

### 2.1 System boundaries

| Boundary | What crosses it | What is behind it | Why the line is drawn here |
|----------|-----------------|-------------------|----------------------------|
| **HTTP API** (`openapi.yaml`) | Requests from sellers' clients and moderators; JSON responses and `{error:{code,message}}` | `src/routes/` → `src/services/` → `src/repositories/`, plus `src/http/` (validation, error handler, probes) | The only way in. All untrusted input is validated here, before anything is stored, and nothing internal (stack traces, SQL) goes back out. Moderators are **not** authenticated (§9). |
| **API ↔ worker** (two processes, same image) | **Nothing directly.** They share only the `moderation_jobs` and `listings` tables; the worker never calls the API | Worker: `src/worker.js` → `src/worker/loop.js` → `src/services/moderation.js` → `src/moderation/decide.js` + `src/repositories/` | Accepting a listing must never wait for, or fail because of, moderation. Each side scales and restarts on its own (§8). |
| **Application ↔ PostgreSQL** | Parameterised SQL, only from `src/repositories/` | Tables `listings`, `moderation_jobs`, `pgmigrations`; unique/check constraints, row and advisory locks | Every correctness guarantee lives here (§6), so it holds however many API or worker processes run. Application memory is never trusted for coordination. |
| **Seed data** (`seed/*.json`) | Read once at startup, never written | `src/reference/seed.js`: validated, frozen in-memory maps | Read-only input from the brief. The process refuses to start if it is invalid, and the service follows it strictly (A12). |
| **Pure decision core** (inside the worker) | In: a listing plus a `context` the caller loaded. Out: outcome + reasons | `src/rules/` (one function per rule) and `src/moderation/decide.js` | No I/O, so every rule and every combination is unit-tested without a database, and rule precedence exists in exactly one place. |

### 2.2 Layers inside each process

| Layer | Responsibility | Must not |
|-------|----------------|----------|
| `src/routes/` | HTTP: parse, validate (`src/http/validation.js`), pick status codes | contain business rules or SQL |
| `src/services/` | Use cases: submit/get/list (`listings.js`), process one job (`moderation.js`), human decision (`review.js`). Own transaction boundaries. | build HTTP responses |
| `src/rules/`, `src/moderation/decide.js` | Pure rules `(listing, context) → Reason[]`, and the precedence between them (A1, A2, A5, A6) | do I/O |
| `src/repositories/` | All SQL (`listings.js`, `jobs.js`), parameterised | make business decisions |
| `src/db/` | Connection pool, migrations, database readiness checks | contain domain logic |
| `src/reference/` | Seed loading and validation | change at runtime |
| `src/worker/` | Claim loop, polling, concurrency, graceful stop | call the HTTP API |

## 3. Why it is built this way

Each choice below says what was chosen, why, what was rejected, and what it costs.

### 3.1 Technology choices

**PostgreSQL for both storage and the job queue.**
- *Why:* every guarantee the brief asks for (idempotent submission, one committed result
  per phase, one human winner) comes down to **atomic, conditional writes**. Postgres
  enforces them itself with unique constraints, transactions and row locks, so they
  hold however many processes run, instead of depending on application code that could
  race.
- *Why the queue too:* the listing and its job are written in **the same transaction**,
  so a listing can never be saved without its job, or the reverse. With a separate
  broker, that "dual write" can fail halfway and lose accepted work.
- *Rejected:* Redis/BullMQ or RabbitMQ (a second system to run, the dual-write problem
  above, and more images to pull inside the 180-second budget); an in-memory queue
  (accepted work is lost on restart and cannot be shared between workers).
- *Cost:* a Postgres queue handles less throughput than a dedicated broker. That only
  matters at a volume far beyond this service; a broker could be added then.

**Node.js 24 with Express 5.**
- *Why:* the service is small and I/O-bound (HTTP in, SQL out), which Node handles well,
  and Express is the most widely known Node web framework, so a new teammate can read
  it on day one. Express 5 passes errors from `async` handlers to the error handler,
  which keeps every error in one consistent format.
- *Rejected:* larger frameworks (e.g. NestJS): more structure and build tooling than
  six endpoints need, and slower image builds.
- *Cost:* Express validates nothing by itself, so validation is written by hand
  (`src/http/validation.js`) and tested directly.

**`pg` (node-postgres) with plain SQL, no ORM.**
- *Why:* the guarantees in §6 depend on exact statements (`INSERT … ON CONFLICT`,
  `UPDATE … WHERE status = 'pending'`, `FOR UPDATE SKIP LOCKED`). Written by hand,
  they are visible and reviewable. All SQL lives in `src/repositories/`.
- *Rejected:* an ORM (Prisma, Sequelize). It would hide exactly the statements that
  matter, and some add a build step.
- *Cost:* more SQL to write and keep in step with the schema; repository tests against
  real Postgres cover it.

**node-pg-migrate for schema migrations.**
- *Why:* this is built as a service that will live for years. A maintained tool brings
  down-migrations for rollbacks, ordering checks, and handling of statements that cannot
  run in a transaction. Migrations stay plain SQL files with an up and a down section,
  and its advisory lock (mode `wait`) lets the API and worker start together and still
  apply each migration exactly once.
- *Rejected:* a small hand-written runner (no dependency, but it would have to grow into
  all of the above). See AI-NOTES.md.
- *Cost:* one more dependency, and it does not detect edits to an already-applied file;
  the rule is "never edit, add a new one".

**API and worker as separate processes from the same image.**
- *Why:* accepting a listing must never wait for, or fail because of, moderation; the
  two scale and restart independently, which makes restart behaviour (§8) easy to reason
  about. One image means one build and identical code in both.
- *Rejected:* running the worker inside the API process (an API restart would also stop
  moderation, and the two could not be scaled separately).
- *Cost:* one more container in `make run`.

**Seed data held in memory, read-only.**
- *Why:* it is small, never changes at runtime, and is needed on every request (422
  checks) and every evaluation. Each process validates it at startup and refuses to
  start if it is invalid, so a bad seed file can never cause a half-working service.
- *Cost:* changing it means restarting the processes; §9 moves it to the database
  later.

### 3.2 Key design decisions

- **Asynchronous with a durable job record.** The brief says moderation is not instant
  and `POST` must not evaluate inline. A job row written with the listing means accepted
  work survives any crash and is shared by any number of workers (§6).
- **Correctness through guarded writes, not application checks.** Every result is
  committed with `UPDATE … WHERE status = '<expected>'`. Whoever changes the row first
  wins; everyone else matches 0 rows and knows it lost. This is simpler and safer than
  checking first in code, which races, and needs no extra version column.
- **Leases instead of heartbeats.** A claimed job belongs to its worker for 30 s. If the
  worker dies, the lease simply runs out and another worker takes over. Evaluation takes
  milliseconds, so no lease renewal is needed; the attempt number acts as a fencing
  token, so a slow, stale worker can never change a reclaimed job (§5.2).
- **A per-seller lock for duplicates (R3).** Duplicate checks only conflict within one
  seller, so locking per seller keeps different sellers fully parallel while two
  identical listings from the same seller are checked one at a time (A4).
- **Polling instead of push.** An idle worker asks for jobs every 500 ms. It cannot miss
  a job and needs no extra moving parts; the cost is up to half a second of delay.

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
1. Validate the `Idempotency-Key` header (A8) and the body (400), then check `seller_id` /
   `category_id` against seed data (422).
   - **Validation rules:** unknown fields rejected (A13); every field must already have the
     spec's JSON type, with no coercion (`"1000"` or `12.5` for `price_vnd` → 400);
     `price_vnd` is an integer from 0 to `Number.MAX_SAFE_INTEGER`, so every price stays
     exact in JavaScript and R2's integer arithmetic; title/description lengths count
     Unicode characters, as JSON Schema and Postgres do; text is stored as sent (A14).
   - **Error order 400 → 422 → 409/200:** checks that need no database run first, so a
     request that is invalid or refers to unknown data is never stored and never consumes
     its idempotency key; the client can fix it and retry with the same key.
2. In one transaction:
   `INSERT INTO listings … ON CONFLICT (submission_key) DO NOTHING RETURNING id`.
   - Inserted → also `INSERT INTO moderation_jobs`; respond **202** `{id, status}`.
   - Conflict → read the existing row; same `request_hash` → **200** with
     `{id, status}`; different hash → **409**.
   - A replay returns the listing's **current** status (e.g. `published` once moderation
     has run), not a copy of the first response's `pending`: the response should be true
     when it is sent, and the original `id` is what makes the replay idempotent.
3. No rules are evaluated here (including R4, see A2).

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
     pending and older (A4), then run `decide()` (pure).
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

1. Validate the body (400), with the same strictness as listing submissions (A13–A14):
   unknown fields rejected, no type coercion, `moderator_id` 1–200 characters, `note` at
   most 5000. `moderator_id` is trusted as sent (no authentication).
2. One statement: `UPDATE listings SET status = published|rejected, decision = …,
   decided_at = now(), decided_by = $moderator WHERE id = $1 AND status = 'needs_human'
   RETURNING …`. The new `decision` is built inside the same `UPDATE` from the row it
   replaces, so the escalation reasons are copied into the `HUMAN` reason's
   `detail.escalation_reasons` without a read-then-write gap. The stored decision is
   `{outcome, reasons: [{rule_id: "HUMAN", message: "approved by moderator m-1: <note>",
   detail: {moderator_id, note, escalation_reasons}}]}`: the HUMAN reason is what decided
   the outcome (A15), and "why was this reviewed?" is never lost.
3. One row → **200** with the listing. Zero rows → look the listing up: missing → **404**,
   otherwise **409**. Checks run 400 → 404 → 409, for the same reason as in §5.1: checks that
   need no database come first.

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
| Two identical listings never both published, never both rejected (R3) | Per-seller advisory lock around check + commit; "decided first, then submitted first" tie-break (A4) |
| Failures reach an operator | Jobs end in `failed` with `last_error` and are logged at error level. In the current scope an operator finds them by querying `moderation_jobs` directly (A7). An admin API is deferred (§6.1). |
| Decisions are explainable | Each rule that decided the outcome adds a `Reason {rule_id, message, detail}` (A15); R1 gives one reason per matched term, quoting the term exactly as the seed file writes it in `message`, as the spec requires, and naming the field(s) it was found in; approvals carry an R4 or `PASS` reason (A16) |

R1–R5 make no external writes, so there are no external side effects to retry.

### 6.1 Not built: operator API for failed jobs

**Cut for the one-day timebox**; it is near the top of the production list (§9). What it
would look like:

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
| Worker down (no worker running) | Everything | The API keeps accepting listings (202); they wait as `queued` jobs and are decided when a worker starts. `/readyz` stays 200: the API itself can do its job. |
| Database outage | Everything already committed | API requests wait at most 5 s for a connection, then return `500 internal_error` (details only in logs); `/readyz` turns 503. Workers log the error and keep polling; a job interrupted mid-attempt is reclaimed after its lease. One attempt may be used up per interrupted job. |

**Supported topology:** one PostgreSQL primary; any number of API instances; any number
of worker instances. All coordination happens in Postgres, so adding instances needs no
configuration. `make run` starts one `db`, one `api` and one `worker`; the API is
published on host port `${PORT:-8080}`.

## 9. What I would change first for production

In order of importance:

1. **Authentication.** Anyone who can reach the API can submit listings or act as a
   moderator: `moderator_id` is trusted as sent. Moderators and clients must log in, and
   only moderators may call the decision endpoint.
2. **A decision history.** Only the current decision is stored. Keep every automated
   and human decision (who, what, when) in an append-only table, so any outcome can be
   traced and audited later.
3. **Monitoring and alerts.** Failed jobs are stored and queryable (A7), but nobody is
   told. Alert on failed jobs, on listings waiting too long, and on error rates.
4. **An admin screen or API for failed jobs** (§6.1), so retrying one does not mean
   running SQL by hand.
5. **Banned keywords, sellers and categories in the database**, with a way for staff to
   update them. Today they come from the seed files, so every change needs a redeploy.
6. **Listing expiry.** Published listings never expire today (A11); add the expiry rule
   once the business defines a listing's lifetime.
