# The contract (BRIEF §3.1): `make run` and `make test`.
# Needs only make, Docker (with the compose plugin) and a POSIX shell on the host.

.PHONY: run test clean lock

PORT ?= 8080
export PORT

# One compose project per host port, so two runs on different ports never collide.
PROJECT ?= listing-moderation-$(PORT)

## run: build and start db + api in the foreground on $(PORT); Ctrl-C stops and removes the containers.
run:
	@sh scripts/run.sh $(PROJECT)

## test: run the test suite in containers; no running service needed; exits non-zero on failure.
test:
	@sh scripts/test.sh

## clean: also delete the database volume for this PORT (data is kept between `make run`s otherwise).
clean:
	docker compose -p $(PROJECT) down -v --remove-orphans

## lock: (re)generate package-lock.json using Node in Docker; commit the result.
lock:
	docker run --rm -v "$(CURDIR)":/app -w /app node:24-alpine \
		npm install --package-lock-only --ignore-scripts --no-audit --no-fund
