# AGENTS.md

Agent instructions for the **Listing Moderation Service** take-home (Chotot backend).
Read this file fully before any change. It is project-specific on purpose: if something
here conflicts with your general habits, this file wins.

---

## 1. What this project is

An HTTP service that accepts classified listings, moderates them **asynchronously**
against rules R1–R5, and lets a human moderator resolve listings that need review.

- **Timebox: about one day of effort.** Prefer a correct, small system over a broad one.
  When something must be cut, say so and record the cut (README "Known limitations").
- **Reviewers read the design and the reasoning**, not just the code: `ARCHITECTURE.md`,
  `ASSUMPTIONS.md`, `AI-NOTES.md` and this file are graded deliverables.
- **Stack:** Node.js + Express, PostgreSQL, Docker / Docker Compose.
  Node 24 (Alpine images), ES modules, Express 5 (async errors reach the error handler
  without wrappers). Tests use the built-in `node:test` runner and global `fetch`; no
  test framework dependency. Tests run inside a container (see §3).
- **Layout:** `src/app.js` builds the app (no listening, no signals; used by tests),
  `src/server.js` is the process entry point, `src/config.js` reads env once,
  `src/http/` holds error and health handlers, `src/db/` the pool, migrations
  (node-pg-migrate, plain SQL up/down files) and DB readiness checks,
  `src/repositories/` all SQL, `src/reference/` the seed loader, `scripts/` the `make` helpers.
  `ARCHITECTURE.md` and `ASSUMPTIONS.md` sit at the repo root (brief §4 lists them
  there); `docs/` holds only the plan and context notes.

## 2. Sources of truth (in priority order)

1. **`openapi.yaml`** — the wire contract. Normative and checked by an external
   conformance suite. You may **add** endpoints, fields or status codes; you may **never
   change or remove** anything it already defines (paths, payload shapes, enums, codes).
2. **`BRIEF.md`** — the exercise text. It lives on the developer's machine only and is
   git-ignored: **never commit it, never delete the ignore rule**. If you cannot see it,
   §4 of this file summarises what matters; ask the user rather than guess.
3. **`ASSUMPTIONS.md`** — decisions taken where the brief is unclear or
   contradictory. Code must match these decisions exactly.
4. **`ARCHITECTURE.md`** — the agreed design.
5. Existing code, then your own suggestions.

`seed/*.json` is **read-only input**. Load it at startup; do not edit, reformat or
"fix" it. If it looks wrong, that is an assumption to raise, not a file to change.

The brief is **deliberately incomplete and self-contradictory**. When you hit a gap:
do not silently pick an interpretation. Stop, describe the options, recommend one, and
once the user decides, add an entry to `ASSUMPTIONS.md` in the required format (§8).

## 3. Hard constraints (checked mechanically — breaking any of these fails the submission)

- `make run` starts **everything** (app, Postgres, worker) via `docker compose`, on a
  machine with only `make`, Docker and `curl`. **Assume no Node.js on the host.** Never add
  a step that needs `npm` on the host.
- The API must answer within **180 s of `make run` on a cold machine**, image build
  included. Keep images lean: small base image, `npm ci --omit=dev` in the runtime stage,
  a `.dockerignore`, no heavy build tooling.
- `make run` honours **`PORT`** (default `8080`) as the **published host port**;
  the container's internal port is ours to choose.
- `make run` stays **in the foreground** and **stops what it started** on Ctrl-C/SIGTERM
  (e.g. `docker compose up` with a trap / `down` on exit). Use a unique compose project
  name so it never touches other containers.
- `make test` works from a **clean checkout with no running service**: it starts its own
  dependencies (e.g. a throwaway Postgres in compose), runs tests in a container,
  cleans up, and **exits non-zero on failure**.
- The service must run correctly with the seed data loaded at startup.
- Before declaring the work done: clone the repo into an empty folder and run
  `make run` and `make test` there. Uncommitted files are the most common failure.

## 4. Domain summary (from the brief)

**Lifecycle** (API `Status` enum): `pending` → `auto_approved` | `auto_rejected` |
`needs_human`; `auto_approved` → `published` → `expired`; `needs_human` → `published` |
`rejected`. (The brief's diagram also shows `draft`, which is **not** in the API enum —
see ASSUMPTIONS.)

**Rules** — evaluated by the worker, never inline in `POST /v1/listings`:

| ID | Rule | Outcome |
|----|------|---------|
| R1 | Title/description contains a term from `seed/banned_keywords.json` — case-insensitive, **word-boundary** match. Terms can be multi-word (`"hang gia"`). | always rejected |
| R2 | Price `> 3×` or `< 1/3` of the category `median_price_vnd` | `needs_human` |
| R3 | Same seller already has another **active** listing that is the **same** | rejected as duplicate |
| R4 | Seller `trust_score >= 80` (80 is included) | bypasses moderation, published immediately |
| R5 | Seller `verified: false` | `needs_human` |

Rule precedence, the meaning of "same" and "active", and how R4 interacts with R1/R5
are **decided in `ASSUMPTIONS.md`**. Implement precedence in **one place** (the
decision function); never duplicate it in routes, SQL or the worker.

**Moderation phases** — each may commit **at most one** result:

| Phase | Starts in | Committed result |
|-------|-----------|------------------|
| Automated | `pending` | one approve / reject / escalate |
| Human | `needs_human` | one `published` or `rejected` |

## 5. API contract details that are easy to get wrong

- `POST /v1/listings` → **202** `{id, status: "pending"}` on first submission;
  **200** with the same body on a replay of the same submission; **409** if a
  submission key is reused with a **different** body; **400** for invalid bodies;
  **422** if `seller_id` or `category_id` does not exist in the seed data.
  How the submission key is carried (header name, required or not) is an ASSUMPTIONS
  entry — the spec does not define it.
- `GET /v1/listings` (list, filters `seller_id`, `status`, `limit` 1–100 default 20,
  **newest first**) is defined in the spec, so it must be implemented.
- `GET /v1/listings/{id}` → 200 or 404. `decision` is `null` while `pending`; once
  decided it has `outcome` (`approved` | `rejected` | `escalated`) and `reasons[]`.
  Set `decided_at` when a result is committed.
- **R1 reasons:** `message` must contain the matched banned term **verbatim** (letter
  case aside), e.g. `title contains banned term "replica"`. Putting it only in `detail`
  fails the conformance suite.
- Every fired rule produces a `Reason {rule_id, message, detail?}` that a moderator can
  understand without reading code. Approvals carry reasons too (e.g. R4 bypass).
- `POST /v1/listings/{id}/decision` → 200 with the full `Listing` for the single winning
  request; **409** for any listing not in `needs_human`, including concurrent losers and
  repeats; 404 if missing. Body: `decision` (`approve`|`reject`), `moderator_id`, `note?`.
- Errors always use `{"error": {"code", "message"}}`. Never leak stack traces or SQL.
- `/livez` and `/readyz` return `{"status": "ok"}` / 503. What each one checks must be
  written in `ARCHITECTURE.md` (liveness = process alive, no dependency checks;
  readiness = DB reachable, migrations applied, seed loaded — unless ARCHITECTURE says
  otherwise).

## 6. Correctness invariants (the core of what is reviewed)

Assume clients retry **aggressively and concurrently**, and several workers may evaluate
the same listing. Every one of these must hold under concurrency, and must be enforced
by the **database**, not by checks in application memory.

1. **Idempotent submission.** Enforce with a **unique constraint** on the submission key
   and `INSERT … ON CONFLICT`; then compare the stored request hash to decide 200 vs 409.
   **Never** "SELECT, then INSERT if missing" — it races.
2. **One committed automated result.** Commit with a conditional update in one
   transaction, e.g. `UPDATE listings SET status=$new, decision=… WHERE id=$id AND
   status='pending'`, and treat `rowCount = 0` as "someone else already committed;
   discard my result". Status and decision are written in the **same statement /
   transaction** so they are never out of sync.
3. **Stale attempts never overwrite.** A late automated attempt must not replace a
   committed result or a later human decision. The `WHERE status = …` guard (or a
   version column) is what guarantees this; do not remove it to "simplify".
4. **One human winner.** Same pattern with `WHERE status='needs_human'`; losers → 409.
5. **No lost work.** A listing accepted as `pending` must eventually be evaluated, even
   if a worker crashes mid-job. Use a durable job record in Postgres (claim with
   `FOR UPDATE SKIP LOCKED` plus a lease / visibility timeout so crashed claims are
   re-picked). Jobs that keep failing past the retry limit must become **visible**
   (state/field the API or an operator can query), not only a log line.
6. **R3 under concurrency.** Two identical listings submitted at once must not both be
   approved, and must not reject each other. Define the tie-break (see ASSUMPTIONS) and
   enforce it in a transaction or with a lock, not by an unguarded read.
7. **Rules are pure.** Each rule is a function `(listing, context) → Reason | null` with
   no I/O. Data it needs (seller, category median, existing listings) is loaded by the
   caller. This keeps rules unit-testable and lets the decision function be one place.

## 7. Code layout and conventions

- `routes/` (HTTP, validation, status codes) → `services/` (use cases, transactions) →
  `rules/` + `moderation/decide` (pure) → `repositories/` (all SQL).
- Worker is a separate entry point / container using the same services; it does not call
  the HTTP API.
- Validate requests against the spec limits (title 1–200, description ≤ 5000,
  `price_vnd` integer ≥ 0, required fields). Reject unknown types with 400.
- Parameterised SQL only. Schema changes via migrations that run automatically on
  startup. Constraints (unique, check, not null) in the schema, not only in code.
- Config via environment variables with defaults that work under `make run`; provide
  `.env.example`; never commit `.env`.
- Times in UTC, ISO-8601. Money is integer VND (no floats); compute R2 bounds with
  integer arithmetic (`price * 3 < median`, `price > median * 3`) to avoid rounding.
- Structured logs with listing id and job attempt on every worker log line.

## 8. Documentation you must keep current

| File | Rule |
|------|------|
| `ASSUMPTIONS.md` | Every ambiguity → `## A<n> — <title>` with **Ambiguity** (quote the brief), **Decision**, **Rationale**, **Cost of being wrong**. All four fields, every entry. |
| `ARCHITECTURE.md` | Storage/queue choice **and why**; what `/livez` and `/readyz` report; what survives a worker restart and a full restart; supported worker/DB topology; how each §6 invariant is enforced; what to change first for production. |
| `README.md` | Replace the starter-kit text: how to run/test, test prerequisites, **where this agent file lives**, known limitations / cuts. |
| `AI-NOTES.md` | Half a page, written **as we go**: what was delegated vs written by hand, where the model was wrong and how it was caught, a path abandoned. When you (the agent) make a mistake the user catches, remind them to log it. |
| `docs/IMPLEMENTATION_PLAN.md` | Tick tasks only after tests pass. |

Do not duplicate content across files; link instead.

## 9. Testing

- Unit tests: each rule (including boundaries: trust 79/80, price exactly 3× and 1/3,
  price 0, banned term as substring of another word must **not** match, multi-word
  term, mixed case), and the decision function for every rule combination in
  ASSUMPTIONS.
- Integration tests against **real Postgres** (not mocks) for: idempotent replay (200),
  key reuse with different body (409), concurrent identical submissions → exactly one
  listing, two workers racing on one listing → one committed result, stale worker after
  human decision → no overwrite, concurrent human decisions → one 200 and the rest 409,
  worker crash / lease expiry → listing still gets decided.
- Use the seed sellers as fixtures: `s-1001` trusted, `s-1005` trusted **and** unverified,
  `s-1006` exactly 80, `s-1007` 79, `s-1008` new and unverified.
- Never claim tests pass without running them. If they cannot run here, say so.

## 10. Known pitfalls (update this list when the model gets something wrong)

- Writing the submission check as SELECT-then-INSERT (races under concurrent retries).
- Evaluating rules inside `POST /v1/listings` "because R4 says immediately". The POST
  only stores and enqueues.
- Using an in-memory queue/array for jobs — accepted work is lost on restart and cannot
  be shared by several workers.
- Implementing R1 with plain `\b…\b`: JavaScript `\b` treats accented letters (`à`, `ả`,
  `đ`…) as non-word characters, so a term can "match" inside a Vietnamese word. Use
  Unicode-aware boundaries (e.g. `(?<![\p{L}\p{N}])term(?![\p{L}\p{N}])` with the `u`
  flag) and escape the term. **Decided (A12): no accent folding** — `hàng giả` must
  **not** match `hang gia`; do not add NFD/diacritic stripping.
- Putting the R1 term only in `detail` instead of in `message`.
- Editing `openapi.yaml` to fit the implementation, or changing seed files.
- Adding a host-side `npm install` to the Makefile.
- **(Phase 1, real)** First `scripts/run.sh` ran `docker compose up` in the foreground.
  GNU make forwards SIGTERM to the script, but `sh` only runs a trap after the
  foreground command ends, so the stack kept running. Fix: start compose in the
  background and `wait` on it. Caught by simulating signals with a fake `docker`.
- Shell scripts and the Makefile need LF line endings (`.gitattributes`); a Windows
  checkout with CRLF breaks `sh` on the Linux runner.
- **(Phase 1 review, real)** File-name case: `AGENTS.MD` and `AI-NOTE.md` instead of
  `AGENTS.md` / `AI-NOTES.md`. Windows does not care; the Linux grader and links do.
  Fixed with `git mv`.
- **(Phase 1 review, real)** Dockerfile fell back to `npm install` when the lockfile
  was missing, so builds were not reproducible and nobody noticed. The lockfile is now
  required (`npm ci`); regenerate with `make lock`.
- Never edit a migration that has been applied: node-pg-migrate does not detect it and
  databases silently drift. Add a new `<timestamp>_<name>.sql` instead.
- node-pg-migrate's default `advisoryLockMode` is `fail`: a second process starting at
  the same time crashes. We pass `wait`; keep it.
- `pg` returns `bigint` as a string. Our pool parses it to a number (safe because
  `price_vnd` is capped at `Number.MAX_SAFE_INTEGER` in validation — Phase 3 must do that).
- _(add real incidents here as they happen, with one line on the fix)_

## 11. How to work with the user

The user is learning backend engineering and owns all business and design decisions.

- **Ask first** for: anything that changes behaviour defined by the brief, a new
  assumption, an API addition, schema/topology changes, a new dependency or service.
  For each, give the options, consequences and your recommendation in a few lines.
- **Just do it** (and mention it) for: naming, internal structure, small refactors
  inside the current task, test organisation.
- Work in small tasks from `docs/IMPLEMENTATION_PLAN.md`. Before a task: files to touch,
  approach, edge cases. After: what changed, tests run and their result, open issues,
  suggested next task. Explain non-obvious concepts (transactions, locking, idempotency)
  briefly and practically.
- Respect the timebox: if a task is growing, stop and propose a cut.
- Do not commit or push unless asked. Never commit `BRIEF.md`, `.env` or credentials.
