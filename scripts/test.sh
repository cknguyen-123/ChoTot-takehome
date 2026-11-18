#!/bin/sh
# Builds the test image, runs the test suite in a container (no Node.js needed on
# the host), removes everything it created, and exits with the tests' exit code.
# Usage: sh scripts/test.sh
set -eu

# Unique per invocation so concurrent runs and `make run` are never affected.
PROJECT="listing-moderation-test-$$"

cleanup() {
  # --rmi local also deletes the test image built for this run (its name is unique
  # per run, so without this every `make test` would leave one behind).
  docker compose -p "$PROJECT" --profile test down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose -p "$PROJECT" --profile test build test
docker compose -p "$PROJECT" --profile test run --rm test
