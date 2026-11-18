#!/bin/sh
# Starts the full stack in the foreground and always tears it down on exit:
# normal exit, Ctrl-C (SIGINT), SIGTERM (GNU make forwards it here), or `make`
# being killed outright (SIGKILL).
# Usage: sh scripts/run.sh <compose-project-name>
set -eu

PROJECT="$1"
make_pid=$PPID
self_pid=$$

down() {
  docker compose -p "$PROJECT" down --remove-orphans >/dev/null 2>&1 || true
}

up_pid=""
watchdog=""
cleanup() {
  trap - EXIT INT TERM
  [ -n "$watchdog" ] && kill "$watchdog" 2>/dev/null || true
  echo "Stopping $PROJECT ..." >&2
  down
  [ -n "$up_pid" ] && kill "$up_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# True while make is still our parent. When make dies we are re-parented, which
# works even where the dead make lingers as an unreaped zombie.
make_alive() {
  ppid=$(ps -o ppid= -p "$self_pid" 2>/dev/null | tr -d ' ') || ppid=""
  if [ -n "$ppid" ]; then
    [ "$ppid" = "$make_pid" ]
  else
    kill -0 "$make_pid" 2>/dev/null
  fi
}

# If make is killed without passing a signal on (e.g. SIGKILL), tear down anyway.
(
  while make_alive; do sleep 2; done
  down
) &
watchdog=$!

# Run compose in the background and wait for it: `wait` is interrupted by a
# trapped signal, whereas a foreground command would delay the trap until it exits.
docker compose -p "$PROJECT" up --build --remove-orphans --abort-on-container-exit &
up_pid=$!
wait "$up_pid"
