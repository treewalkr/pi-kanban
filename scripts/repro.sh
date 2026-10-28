#!/usr/bin/env bash
# repro.sh — the sanctioned way to run a throwaway kanban board for reproducing bugs.
#
#   scripts/repro.sh                 # board on a free scratch port (≥4611), temp DB, 30-min TTL
#   REPRO_AGENTS=1 scripts/repro.sh  # also run the auto-review loop (planner/reviewer/builder)
#   REPRO_TTL=600 scripts/repro.sh   # die after 10 minutes instead of 30
#   REPRO_PORT=4615 scripts/repro.sh # pin a specific scratch port
#
# NEVER reproduce against PORT=4600 or with KANBAN_SHARE_PORT=1 — that stacks a
# second board on the production port (the 10/29 ghost-board incident).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${REPRO_PORT:-}"
if [ -z "$PORT" ]; then
  for p in 4611 4612 4613 4614 4615 4616 4617 4618 4619 4620; do
    if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then PORT="$p"; break; fi
  done
fi
[ -n "$PORT" ] || { echo "repro: no free port in 4611-4620 — pass REPRO_PORT=<n>" >&2; exit 1; }

DB="$(mktemp -t kanban-repro)"
TTL="${REPRO_TTL:-1800}"
PIDFILE="/tmp/kanban-repro-$PORT.pid"
WATCHDOG_PID=""

AGENTS="${REPRO_AGENTS:-0}"
for arg in "$@"; do
  case "$arg" in
    --agents|-a) AGENTS=1 ;;
    *) echo "repro: unknown flag $arg (supported: --agents|-a)" >&2; exit 1 ;;
  esac
done

# sanitize: a repro must never inherit the production server's identity — no
# shared port, no live share token, no agent loop, no production DB
unset KANBAN_SHARE_PORT KANBAN_SHARE_TOKEN KANBAN_AUTO_REVIEW KANBAN_DB
EXTRA="KANBAN_DB=$DB"
[ "$AGENTS" = "1" ] && EXTRA="KANBAN_AUTO_REVIEW=1 $EXTRA"

# TTL watchdog (macOS has no GNU timeout(1)). Identity-checked: it only kills
# the server it was spawned for, never a later repro that reused the pidfile.
watchdog() {
  local ttl="$1" pidfile="$2" guarded="$3"
  sleep "$ttl"
  if [ -f "$pidfile" ] && [ "$(cat "$pidfile")" = "$guarded" ]; then
    kill "$guarded" 2>/dev/null || true
  fi
}

echo "repro board → http://127.0.0.1:$PORT  (db $DB, ttl ${TTL}s, agents $AGENTS)"
echo "stop early: kill \$(cat $PIDFILE)"

cleanup() {
  # kill the watchdog before the server so it can never outlive this script
  [ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null || true
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  rm -f "$DB" "$DB-shm" "$DB-wal"
}
trap cleanup EXIT

env PORT="$PORT" $EXTRA bun run src/index.ts &
echo $! > "$PIDFILE"
watchdog "$TTL" "$PIDFILE" "$(cat "$PIDFILE")" &
WATCHDOG_PID=$!
wait "$(cat "$PIDFILE")" || true
