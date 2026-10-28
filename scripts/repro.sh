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
EXTRA=""
[ "${REPRO_AGENTS:-0}" = "1" ] && EXTRA="KANBAN_AUTO_REVIEW=1"

# TTL watchdog (macOS has no GNU timeout(1)): kills the server after REPRO_TTL seconds
watchdog() { sleep "$1"; [ -f "$2" ] && kill "$(cat "$2")" 2>/dev/null || true; }

echo "repro board → http://127.0.0.1:$PORT  (db $DB, ttl ${TTL}s, agents ${REPRO_AGENTS:-0})"
echo "stop early: kill \$(cat $PIDFILE)"

cleanup() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  rm -f "$DB" "$DB-shm" "$DB-wal"
}
trap cleanup EXIT

env KANBAN_DB="$DB" PORT="$PORT" $EXTRA bun run src/index.ts &
echo $! > "$PIDFILE"
watchdog "$TTL" "$PIDFILE" &
wait "$(cat "$PIDFILE")" || true
