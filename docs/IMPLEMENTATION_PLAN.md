
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

- [ ] Task 3.1: Implement listing submission API
- [ ] Task 3.2: Implement request validation
- [ ] Task 3.3: Persist listing submissions
- [ ] Task 3.4: Implement listing retrieval API
- [ ] Task 3.5: Write API tests

## Phase 4: Moderation Engine

- [ ] Task 4.1: Implement individual moderation rules
- [ ] Task 4.2: Implement rule evaluation
- [ ] Task 4.3: Implement moderation outcomes
- [ ] Task 4.4: Write rule unit tests
- [ ] Task 4.5: Test combined moderation scenarios

## Phase 5: Background Processing

- [ ] Task 5.1: Design moderation job lifecycle
- [ ] Task 5.2: Implement job persistence
- [ ] Task 5.3: Implement background worker
- [ ] Task 5.4: Handle processing failures
- [ ] Task 5.5: Test asynchronous processing

## Phase 6: Human Review

- [ ] Task 6.1: Implement human decision API
- [ ] Task 6.2: Validate moderation decisions
- [ ] Task 6.3: Handle conflicting decisions
- [ ] Task 6.4: Test human review workflow

## Phase 7: Integration and Finalization

- [ ] Task 7.1: Integration testing
- [ ] Task 7.2: Error handling review
- [ ] Task 7.3: Docker review — cold-machine timing under 180 s, image size (initial setup is Task 1.7)
- [ ] Task 7.4: Documentation
- [ ] Task 7.5: Final end-to-end testing
