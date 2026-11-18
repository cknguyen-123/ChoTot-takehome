# Listing Moderation Service

An HTTP service that accepts classified listings, moderates them asynchronously
against rules R1–R5, and lets a human moderator resolve listings that need review.
Node.js 24 + Express 5, PostgreSQL 17, Docker Compose.

> **Status:** Phase 3 (listing endpoints). Listings can be submitted, fetched and
> listed. They stay `pending` until the moderation worker exists (Phase 5). The `/v1/listings` endpoints come
> in later phases; see [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Prerequisites

Only `make`, Docker (with the Compose plugin) and `curl`. **No Node.js is needed on
the host**: dependencies are installed and tests run inside containers.

## Run

```sh
make run              # API on http://localhost:8080
PORT=8081 make run    # API on http://localhost:8081
```

`make run` builds the images, starts PostgreSQL and the API in the foreground, and
stops and removes the containers on Ctrl-C. Data is kept in a Docker volume between
runs; `make clean` deletes it.

```sh
curl -s localhost:8080/livez    # {"status":"ok"}
curl -s localhost:8080/readyz   # {"status":"ok","checks":{"seed":"ok","database":"ok","migrations":"ok",...}}
```

## Try it

With `make run` going, in a second terminal (Git Bash on Windows):

```sh
# Submit: 202 {"id": "...", "status": "pending"}
curl -i -X POST localhost:8080/v1/listings   -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-001'   -d '{"seller_id":"s-1002","category_id":"c-phones","title":"iPhone 13 128GB","description":"Used, good condition","price_vnd":12000000}'

# Same command again: 200 with the same id (idempotent replay)
# Same key, different body (e.g. another price): 409 idempotency_key_reused

# Fetch one, and list a seller's listings (newest first)
curl -s localhost:8080/v1/listings/<id>
curl -s 'localhost:8080/v1/listings?seller_id=s-1002&status=pending&limit=5'
```

`POST /v1/listings` requires an `Idempotency-Key` header (A8) and rejects fields the
spec does not define (A13). Seed sellers are `s-1001`…`s-1008`; categories are
`c-phones`, `c-laptops`, `c-motorbikes`, `c-furniture`, `c-fashion`.

## Test

```sh
make test
```

Needs no running service. It builds a test image, starts a throwaway in-memory
Postgres, runs the suite with Node's built-in test runner inside a container (each
database test file gets its own fresh database), removes everything it created, and exits non-zero if
any test fails. Each run uses its own Compose project, so it never touches a running
`make run`.

## Other targets

| Target | What it does |
|--------|--------------|
| `make clean` | Removes the containers **and the database volume** for `$PORT`. |
| `make lock` | Regenerates `package-lock.json` using Node in Docker. Run after changing `package.json`, then commit the lockfile. |

## Repository map

| Path | Contents |
|------|----------|
| [AGENTS.md](AGENTS.md) | **AI agent configuration** — the instructions the coding agent works from. |
| [AI-NOTES.md](AI-NOTES.md) | How AI was used: what was delegated, what it got wrong, what was abandoned. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Design, storage/queue choice, health probes, restart behaviour, guarantees. |
| [ASSUMPTIONS.md](ASSUMPTIONS.md) | Decisions taken where the brief is unclear or contradictory. |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Task list and progress. |
| `openapi.yaml` | The API contract (unchanged from the starter kit). |
| `seed/` | Sellers, categories and banned keywords, loaded at startup (read-only). |
| `src/`, `test/` | Application code and tests. |

## Known limitations

- Moderation rules, the worker and human decisions are not implemented yet, so
  listings stay `pending`.
- `POST /v1/listings` requires an `Idempotency-Key` header (A8).
- Nothing moves listings to `expired` (A11).
- R1 matches banned terms as written: `hàng giả` (with accents) is not caught by
  `hang gia` (A12).
- Moderator identity (`moderator_id`) will be trusted as sent; there is no
  authentication.
- Failed moderation jobs are visible by querying the database, not through an API
  (see ARCHITECTURE.md §6.1).
