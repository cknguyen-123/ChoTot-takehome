#!/bin/sh
# Builds the test image, runs the test suite in a container (no Node.js needed on
# the host), removes everything it created, and exits with the tests' exit code.
# Usage: sh scripts/test.sh
set -eu

# Unique per invocation so concurrent runs and `make run` are never affected.
PROJECT="listing-moderation-test-$$"

cleanup() {
  docker compose -p "$PROJECT" --profile test down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose -p "$PROJECT" --profile test build test
docker compose -p "$PROJECT" --profile test run --rm test
