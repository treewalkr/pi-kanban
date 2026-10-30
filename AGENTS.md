# kanban — task board for the pi agent

Local-first Kanban board: Elysia API + Svelte 5 SPA + `kanban` CLI over one SQLite file. Humans get the web UI, agents get the CLI.

## Layout

- `src/` — Bun/TS: `db.ts` (SQLite + all queries), `app.ts` (Elysia app, exports `type App`), `index.ts` (server entry), `cli.ts` + `render.ts` (CLI)
- `web/` — Vite + Svelte 5 SPA (board UI), calls the API via Eden Treaty
- `skills/pi-kanban/SKILL.md` — pi skill, installed to `~/.pi/agent/skills/pi-kanban/` by `scripts/install.sh`
- `data/kanban.db` — SQLite DB (gitignored); `KANBAN_DB` env var overrides the path (tests use this)
- `worker_pools` table (`src/db.ts`) + `/pools` routes (`src/app.ts`) — parallel worker pools for auto-review
- `lane_events` table (`src/db.ts`) + `/stats` route (`src/app.ts`) + `kanban stats` — audit trail and board analytics

## Rules

- **Eden Treaty only** for frontend → backend calls; types flow from `src/app.ts`'s `export type App`
- **Svelte 5 runes only** — no legacy stores, no `$:` reactive statements
- **Elysia built-in `t`** for validation; consult the `/elysiajs` skill when unsure
- SQL lives in `src/db.ts` only; the API and CLI are thin layers over its query functions
- Ports: API `4600`, web dev `5174`; server binds `127.0.0.1` only — never expose off localhost. Reproducing board behavior: always `scripts/repro.sh` (scratch port ≥ 4611, temp DB, TTL, auto-cleanup) — never `PORT=4600`, never `KANBAN_SHARE_PORT=1`, and kill repro servers before the session ends
- After plan approval, attach the plan to its card before implementing: write it to a file, run `kanban attach <id> <plan-file>`; re-attaching a revised plan versions it. The human records the verdict with `kanban approve <id>` (arms the plan-build agent) or `kanban reject <id> --message <feedback>` (planner re-plans) — agents never run the gate themselves
- When a human overrides a review verdict or catches what review missed, append one dated line to `REVIEW.md` — the auto-review agents read it every session

## Commits

- Commit often: one small, focused commit per logical change; never batch unrelated work
- Prefix with a type: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`
- One line, imperative, no body, no Co-Authored-By

## Git workspaces

- **When**: Any card-sized, multi-commit task is developed in its own workspace; the main checkout stays on `main` and clean.
- **Create**: Run `scripts/workspace.sh new <slug>` from the repo, then `bun install` inside the new worktree.
- **Return**: Commit inside the workspace per the Commits rules, then run `scripts/workspace.sh done <slug>` from the main checkout — it merges (`--no-ff`, message `merge: <slug>`), removes the worktree, deletes the branch, and verifies main is clean.
- **Cleanup/staleness**: After `done`, `git worktree list` must show only expected worktrees; to discard an unwanted workspace use `git worktree remove` + `git branch -D`.

