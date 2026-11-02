# kanban — task board for the pi agent

Local-first Kanban board: Elysia API + Svelte 5 SPA + `kanban` CLI over one SQLite file. Humans get the web UI, agents get the CLI.

## Layout

- `src/` — Bun/TS: `db.ts` (SQLite + all queries), `app.ts` (Elysia app, exports `type App`), `index.ts` (server entry), `cli.ts` + `render.ts` (CLI)
- `src/chat.ts` + `src/chat-events.ts` — resident chat sessions over the pi SDK (per-card + the board manager on pseudo-card `board`); `/chat/:cardId`, `/chat/:cardId/events` (SSE) in `app.ts`; panel in `web/src/lib/ChatPanel.svelte`, drawer in `web/src/lib/ManagerChat.svelte`
- `src/lane-workers.ts` — lane worker charters/prompts + the serve-process runner that drains `lane_workers` rows (`kanban worker run`); workers act only via CLI verbs, `pi-worker-<lane>` authors, gates human-only
- `web/` — Vite + Svelte 5 SPA (board UI), calls the API via Eden Treaty
- `skills/` — repo skills: `pi-kanban` (board workflow) + one procedural skill per recurring procedure (`e2e-verify`, `repro`, `overnight`, `resume-build`, `release`); `scripts/install.sh` symlinks each into `~/.pi/agent/skills/` and `~/.agents/skills/`
- `src/notice.ts` — board-notice pi extension (Node-safe: only `node:*` imports; reads the board by spawning the installed CLI), symlinked by `scripts/install.sh` to `~/.pi/agent/extensions/kanban-notice.ts`; one `display:false` message at session start and on board-shape changes (`KANBAN_NOTICE=0` disables)
- Card ownership — `tasks.owner` column (`src/db.ts`), `kanban claim`, auto-set on entry to Test + Implement (`handoff`/`approve`), auto-clear on any exit; shown in `overview`, `ls --owner`, `show`
- `data/kanban.db` — SQLite DB (gitignored); `KANBAN_DB` env var overrides the path (tests use this)
- `worker_pools` table (`src/db.ts`) + `/pools` routes (`src/app.ts`) — parallel worker pools for the serve --agents loop
- `lane_events` table (`src/db.ts`) + `/stats` route (`src/app.ts`) + `kanban stats` — audit trail and board analytics
- WIP limits — `lanes.wip_limit` column (`src/db.ts`), `kanban lane limit` (`src/cli.ts`), `wip-over-limit` in `kanban check`, lane count chip in the web UI
- Serve staleness — `/health` reports `version`, `pid`, `git {commit, head, dirty}` (`src/version.ts`); header `⟳ stale` chip (`web/src/lib/service.svelte.ts`) and `kanban check [--port <n>]` flag a lagging, down, or version-split serve; the chip and settings → restart service rebuild + self-respawn it

## Where knowledge lives

- `AGENTS.md` — always-on law: rules every session follows unprompted.
- `skills/<name>/SKILL.md` — on-demand procedures: loaded when the task matches; one per recurring procedure, symlinked into agent skill roots by `scripts/install.sh`.
- `REVIEW.md` — human feedback to the review agents.
- Personal context (preferences, history) lives in agent memory, never in this repo.

A procedure that recurs becomes a skill; a rule that always applies goes here.

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
- Every code commit and every workspace merge passes the git gate (scripts/hooks/ via core.hooksPath, wired by install.sh): docs-only commits skip it; WIP escapes with git commit --no-verify

## Git workspaces

- **When**: Always — every new feature or fix is implemented in a fresh workspace (new branch + worktree off `main`), however small; the main checkout stays on `main` and clean, never used for feature work.
- **Create**: Run `scripts/workspace.sh new <slug>` from the repo, then `bun install` inside the new worktree.
- **Record**: Record the workspace on its card right after creating it: `kanban ws <id> <slug>` — the board shows it while the branch/worktree exists; nothing to clear after `done` (it disappears once git no longer has it).
- **Merge safety**: Before returning, confirm a local merge is safe — parallel agents and workspaces may have advanced `main` since the fork (`git worktree list` shows live workspaces; `git merge-tree --write-tree main <slug>` previews conflicts without touching anything). If it is not safe — conflicts, or another agent mid-flight on the same files — do not force the merge: push the branch and open a PR with `gh pr create` instead; clean up the workspace only after the PR lands.
- **Return**: When the work is finished, always return and clean up — never leave a finished branch or worktree behind. Commit inside the workspace per the Commits rules, then run `scripts/workspace.sh done <slug>` from the main checkout — it merges (`--no-ff`, message `merge: <slug>`), removes the worktree, deletes the branch, and verifies main is clean.
- **Cleanup/staleness**: After `done`, `git worktree list` must show only expected worktrees; to discard an unwanted workspace use `git worktree remove` + `git branch -D`.

