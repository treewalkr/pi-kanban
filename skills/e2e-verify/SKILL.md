---
name: e2e-verify
description: Use when manually verifying kanban web UI changes in a real browser (agent-driven), reproducing a visual or interaction bug, or screenshotting UI state. Covers throwaway-board setup, SSE-churn-safe locators, exact accessible-name matching, device-pixel screenshot clips, and board cleanup for this repo (kanban).
---
# e2e-verify — manual web UI verification for kanban

A procedure for driving the kanban web UI in a real browser to verify a change,
chase a visual bug, or capture a screenshot. The automated Playwright suite
(`npx playwright test`) stays the regression net; this skill is for everything
that suite doesn't cover.

## Never verify against the production board

The board on :4600 is real work. Always verify against a throwaway board:

- Dev servers: `KANBAN_DB="$(mktemp -t kanban-e2e)" bun run dev` — web UI at
  http://localhost:5174, API on :4600 against the temp DB (`KANBAN_DB` is
  honored by `src/db.ts`). Requires two ports free; the web dev server proxies
  nothing — it hardcodes the API origin in DEV (`web/src/api.ts`).
- Built app: `bash scripts/repro.sh` — a scratch port ≥ 4611, temp DB, TTL
  watchdog. See the `repro` skill for its flags.

## The board churns — re-query before every action

Board state re-renders from SSE pushes (`db.watch` → `/events`) on **every** DB
change: any CLI write, any other session, any lane worker can reorder or remove
cards mid-verification. A locator resolved a second ago may be stale now.

- Re-query locators immediately before each action; never reuse cached
  element handles across steps.
- Assert-and-act in one breath: `await expect(locator).toBeVisible()` right
  before the click, not a second earlier.

## Exact accessible names

Playwright's name matching is substring by default, and kanban's accessible
names overlap: lane names, card titles, and buttons share prefixes. Always use
`getByRole(..., { exact: true })` so "Done" doesn't match "Done · archive" or a
card titled "Done-ify".

## Screenshot clips are device pixels

`locator.boundingBox()` reports CSS pixels; the browser tool clips in device
pixels. Multiply clip coordinates by `devicePixelRatio` before passing them,
or the crop lands in the wrong place (2× displays cut half the intended region).

## Cleanup before the session ends

- `kanban rm <id> --force` every card created during verification — parents
  cascade to children, so one rm per created tree is enough.
- Kill the throwaway server before ending the session; never leave it to the
  repro TTL. (`lsof -nP -iTCP:5174 -sTCP:LISTEN` to find dev stragglers.)
