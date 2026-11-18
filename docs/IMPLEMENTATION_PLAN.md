
# IMPLEMENTATION_PLAN.md

## Development Rules

- Divide development into phases.
- Divide each phase into small, independently testable tasks.
- Each task should have a clear objective and acceptance criteria.
- Identify dependencies between tasks.
- Do not implement multiple unrelated tasks simultaneously.
- Complete and verify the current task before moving on.
- Update task status after implementation.

## Phase 1: Project Setup (walking skeleton)

Goal: `make run` serves `/livez` and `/readyz` on `$PORT` from a cold machine, and
`make test` runs the suite in Docker. Docker moved here from Phase 7 because the
startup contract is the one hard pass/fail check.

Status: code written. On the developer's Windows machine (Docker 29, no `make`
installed) the scripts behind the targets were run directly: `sh scripts/test.sh` →
25/25 tests pass in a container; `PORT=8091 sh scripts/run.sh …` → `/livez` and
`/readyz` answer 200 about 22 s after start (base images already cached).
`package-lock.json` generated.
Confirmed by the developer: `make test` and `make run` (Ctrl-C teardown included) work in Git Bash with GNU Make 4.4.1. Fresh-clone check still to do before submitting.

- [x] Task 1.1: Initialize Node.js project — `package.json` (ESM, Node 24, Express 5), `src/` layout
- [x] Task 1.2: Configure Express — `createApp()` factory (`src/app.js`) separate from `src/server.js`
- [x] Task 1.3: Configure environment variables — `src/config.js` (validated, fail fast), `.env.example`
- [x] Task 1.4: Configure error handling — `{error:{code,message}}` for 404, invalid JSON (400), oversized body (413), `AppError`, hidden 500s
- [x] Task 1.5: Health endpoints — `/livez` (no dependency checks), `/readyz` (pluggable checks with timeout; 503 during shutdown)
- [x] Task 1.6: Graceful shutdown on SIGTERM/SIGINT; structured JSON logging
- [x] Task 1.7: Docker — multi-stage `Dockerfile` (runtime/test targets), `docker-compose.yml` (db, api, test profile)
- [x] Task 1.8: `Makefile` — `run` (PORT, foreground, always cleans up), `test` (isolated, exit code), `clean`, `lock`
- [x] Task 1.9: Tests with `node:test` — config, health probes, error handling
- [x] Task 1.10: Generate and commit `package-lock.json` (`make lock`), `.gitattributes` for LF scripts

## Phase 2: Database

Decisions: `pg` with plain SQL (no ORM); **node-pg-migrate** for migrations (developer's
choice over a hand-written runner, see AI-NOTES.md); UUID ids from `gen_random_uuid()`.
Verified: `make test` → 50/50 pass against a throwaway Postgres; `make run` applies the
migration on first start, skips it on restart, `/readyz` reports all four checks ok.

- [x] Task 2.1: Design database schema — `src/db/migrations/1763424000000_init.sql` (constraints in the DB)
- [x] Task 2.2: Configure PostgreSQL connection — `src/db/pool.js` (bigint → number, transaction helper, closed on shutdown)
- [x] Task 2.3: Create database migrations — node-pg-migrate at startup, advisory lock in `wait` mode
- [x] Task 2.4: Implement listing repository — insert listing + job in one transaction (`ON CONFLICT`), find, list
- [x] Task 2.5: Test database operations — migrations (incl. concurrent start), schema constraints, repository (incl. 20 concurrent same-key inserts), seed validation, `/readyz` DB checks
- [x] Task 2.6: Seed loading and validation at startup (`src/reference/seed.js`)

## Phase 3: Listing Management

Decisions A13–A17 (unknown fields → 400 is the developer's choice against the model's
recommendation, see AI-NOTES.md). Verified: `make test` → 97/97 pass; the README `curl`
samples were run against `make run`'s stack and returned 202/200/409/400/422/200.

- [x] Task 3.1: Implement listing submission API — `POST /v1/listings` → 202 / 200 replay / 409
- [x] Task 3.2: Implement request validation — `src/http/validation.js` (A8, A13–A15), order per A16
- [x] Task 3.3: Persist listing submissions — `src/services/listings.js` (request hash, R3 dedup key, 422 checks)
- [x] Task 3.4: Implement listing retrieval API — `GET /v1/listings/{id}` (404 incl. malformed ids), `GET /v1/listings`
- [x] Task 3.5: Write API tests — `test/api-listings.test.js` (incl. 20 concurrent replays), `test/validation.test.js`

## Phase 4: Moderation Engine

Decisions A18–A22 (report only the deciding rules is the developer's choice against the
model's recommendation, see AI-NOTES.md). Verified: `make test` → 136/136 pass.

- [x] Task 4.1: Implement individual moderation rules — `src/rules/r1…r5` (pure, `→ Reason[]`)
- [x] Task 4.2: Implement rule evaluation — `src/moderation/decide.js`, the only place precedence lives
- [x] Task 4.3: Implement moderation outcomes — approved → `published` (A10), rejected → `auto_rejected`, escalated → `needs_human`
- [x] Task 4.4: Write rule unit tests — `test/rules.test.js` (trust 79/80, exact 3x and 1/3, price 0, substrings, Unicode boundaries, multi-word, accents)
- [x] Task 4.5: Test combined moderation scenarios — `test/decide.test.js` (every precedence case with the seed sellers)

## Phase 5: Background Processing

Settings as proposed (5 attempts, 2/4/8/16 s backoff, 30 s lease, 500 ms polling,
concurrency 2; failed jobs visible via SQL per A7). A4 refined (decided first wins).
Verified: `make test` → 164/164 pass; removing the seller lock or the
`status = 'pending'` guard makes a test fail; `make run`'s stack decided four `curl`
submissions (PASS, R1, R5, R3) within a second.

- [x] Task 5.1: Design moderation job lifecycle — queued → running (lease, fencing by `attempts`) → done | queued (retry) | failed
- [x] Task 5.2: Implement job persistence — `src/repositories/jobs.js` (claim with `SKIP LOCKED`, complete, reschedule, fail)
- [x] Task 5.3: Implement background worker — `src/worker.js`, `src/worker/loop.js`, `worker` service in compose
- [x] Task 5.4: Handle processing failures — backoff, `failed` + `last_error`, crash on last attempt, graceful stop
- [x] Task 5.5: Test asynchronous processing — `test/worker.test.js` (races, crash, stale vs human, retries, R3 concurrency)

## Phase 6: Human Review

Decisions A23–A25 as proposed. Verified: `make test` → 174/174 pass; removing the
`status = 'needs_human'` guard makes three tests fail; on `make run`'s stack a `curl`
submission went `needs_human` → approved by `m-1` (200) → second moderator 409.

- [x] Task 6.1: Implement human decision API — `POST /v1/listings/{id}/decision`, `src/services/review.js`
- [x] Task 6.2: Validate moderation decisions — `validateDecisionRequest` (A24), error order 400 → 404 → 409 (A25)
- [x] Task 6.3: Handle conflicting decisions — single guarded `UPDATE … WHERE status = 'needs_human'`
- [x] Task 6.4: Test human review workflow — `test/api-decision.test.js` (10 concurrent moderators, repeats, every status, stale worker end to end)

## Phase 7: Integration and Finalization

- [ ] Task 7.1: Integration testing
- [ ] Task 7.2: Error handling review
- [ ] Task 7.3: Docker review — cold-machine timing under 180 s, image size (initial setup is Task 1.7)
- [ ] Task 7.4: Documentation
- [ ] Task 7.5: Final end-to-end testing
