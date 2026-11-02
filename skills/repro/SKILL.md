---
name: repro
description: Use when reproducing board behavior or testing server changes on a throwaway kanban board. scripts/repro.sh is the only sanctioned way — scratch port ≥ 4611, temp DB, TTL watchdog, production env stripped; this repo (kanban) only.
---
# repro — throwaway boards the sanctioned way

`scripts/repro.sh` is the only sanctioned way to run a kanban board for
reproducing behavior or testing server changes (AGENTS.md rule).

- **Never** reproduce against `PORT=4600` or with `KANBAN_SHARE_PORT=1` — that
  stacks a second board on the production port (the 10/29 ghost-board
  incident).
- Kill repro servers before the session ends; the TTL is a backstop, not a
  cleanup service.

## What the script does

```
scripts/repro.sh                 # board on a free scratch port, temp DB, 30-min TTL
REPRO_PORT=4615 scripts/repro.sh # pin a specific scratch port
REPRO_TTL=600 scripts/repro.sh   # die after 10 minutes instead of 30
REPRO_AGENTS=1 scripts/repro.sh  # also run the agent loop
```

- **Port**: picks the first free scratch port in 4611–4620, or honors
  `REPRO_PORT=<n>` — validated, refuses anything < 4611 (4600 is production).
- **DB**: a fresh `mktemp` SQLite file — no shared state with any real board.
- **TTL watchdog**: dies after 30 minutes by default (`REPRO_TTL` seconds).
- **Identity strip**: unsets `KANBAN_SHARE_PORT`, `KANBAN_SHARE_TOKEN`,
  `KANBAN_AUTO_REVIEW`, and `KANBAN_DB`, so a repro never inherits production
  identity from your shell (the same ghost-board incident).

## Relationship to the e2e suite

The checked-in Playwright suite uses the same harness —
`playwright.config.ts` boots its board via `scripts/repro.sh` (`REPRO_PORT=4621
REPRO_TTL=900`). If your change breaks under repro, it breaks the suite; fix
the change, not the harness.

For UI-driving procedure (locators, screenshots, cleanup) see the `e2e-verify`
skill.
