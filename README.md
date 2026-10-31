# kanban

A local-first kanban board for the [pi](https://github.com/badlogic/pi-mono) coding agent —
one SQLite file, a web UI for humans, a CLI for agents.

Cards flow **Backlog → Plan → Test + Implement → Review → Done → Archive** (lanes are
customizable), behind a fixed **Waiting on you** lane: an agent's `question` comment or a
passed plan review parks the card there — a `↩ from <lane>` chip remembers its home lane,
and any human reply (or the approve/reject gate) returns it. Cards nest into an
**epic → story → subtask** hierarchy; every card moves
independently. The CLI writes the DB directly (no server needed for agent-side CRUD); the
server pushes live updates to the web UI over SSE and raises notifications when a card
enters Review (browser notification in a background tab; set `KANBAN_OSASCRIPT_NOTIFY=1`
to also get a macOS notification from the server when no tab is open).

## Stack

Bun · Elysia (API, `4600`, localhost-only) · Svelte 5 runes SPA (Vite, dev port `5174`) ·
Eden Treaty · `bun:sqlite` (WAL). UI icons from [Lucide](https://lucide.dev/icons)
(`@lucide/svelte`) — pick icons there, don't hand-draw SVGs.

## Install

```bash
bun install
bun run build          # web/dist once (skip while CLI-only)
./scripts/install.sh   # `kanban` into ~/.bun/bin + installs the pi skill
```

## Use

```bash
kanban serve --auto-review --open   # web UI at http://127.0.0.1:4600
bun run dev                         # hacking: api watch + vite dev server
```

One server per port — `serve` refuses a taken port; `kanban stop` and the Settings →
Service **restart** button drain in-flight agent sessions cleanly, never orphan them.

```bash
kanban add <title> --project my-app [--note <text>] [--parent <id>] [--elaborate]
kanban elaborate <id>               # retrofit/retry elaboration on any card
kanban ls · search <query> · show <id> · brief <id>
kanban next                         # lane → priority → oldest; skips blocked, counts waiting
kanban link <id> <other> · unlink <id> <other>
kanban mv <id> <lane> · edit <id> … · done <id> · archive <id> · undo [id] · rm <id> --force
kanban lane ls | add | rename | rm
kanban attach <id> <plan-file>      # versioned plan attach — re-attaching versions it
kanban comment <id> <text…> [--kind comment|review|handoff|question] · comments <id>
kanban handoff <id> <lane> --message <text>   # atomic move + thread record
kanban review <id> (--approve | --block --message <text> [--finding <text>]…)
kanban approve <id> · reject <id> --message <text>   # the human plan gate
kanban stats [id] [--json]          # board summary, or one card's lane times / cycle / gate metrics
kanban check [--json] · stop · help
```

Ids accept any unique prefix; lanes accept slug, prefix, name, or ordinal. `--json`
everywhere; notes render GitHub-flavored markdown in the web UI.

### Auto agents (plan + review)

`--auto-review` runs headless `pi` sessions over the board. Every step lands as a thread
comment (`kanban brief <id>` is the pickup context); each spawn logs to the serve terminal
under `[autoreview]`.

| role | does |
| --- | --- |
| `pi-elaborator` | expands terse notes into intent + acceptance criteria (`--elaborate`, or ✨ in the composer, or ✨ inside an open card) |
| `pi-planner` | plans every Plan-lane card from the [shared template](skills/pi-kanban/plan-template.md); asks `question` comments (with recommended defaults) when an answer would change the plan — the card parks in **Waiting on you** until you reply |
| `pi-plan-reviewer` | checks each plan against the template checklist — block bounces to the planner (max 2 rounds, then it parks for you), pass parks the card in **Waiting on you** |
| **you** | `kanban approve` arms the builder; `reject --message` re-plans. The gate is human-only and works right from Waiting on you. |
| `pi-builder` | builds the approved plan, tests, hands off to review |
| `pi-reviewer` | reviews every card in Review — approve → Done; block → findings land as a `- [ ]` checklist the builder works (max 3 cycles, then it parks for you) |

Dead sessions (model error, quota, stall) post the reason to the thread, mark the card
`✗ session died`, and offer a **↻ resume session** button that re-spawns pi continuing the
same session — preserving earlier reasoning and tokens instead of starting over.

Configure per-role agent settings in the web UI (gear icon in the topbar) — applied on the
next spawn, no restart:

| field | becomes | notes |
| --- | --- | --- |
| provider / model | `--provider` / `--model` | fed by pi's catalog (`pi --list-models`); empty = pi's default |
| thinking | `--thinking` | reviewer, planner + plan reviewer default to `max` |
| skills | `--skill` per line | auto-activates at spawn |
| context | `--append-system-prompt` | standing instructions, your review lens |
| tools | `--tools` | pi allow/deny syntax |
| extra flags | passed through raw | escape hatch |
| timeout | total run cap | 1 min–24 h, default 2 h; the stall watchdog kills silent sessions earlier |

Env overrides win: `KANBAN_AUTOREVIEW_MODEL`, `KANBAN_AUTOREVIEW_THINKING` (`""` disables),
`KANBAN_AUTOREVIEW_TIMEOUT_MS`, `KANBAN_AUTOREVIEW_STALL_MS`. Session parallelism lives in
the Pools settings tab (global max-workers + optional per-pool cap).

### pi skill

`skills/pi-kanban/SKILL.md` (installed to `~/.pi/agent/skills/pi-kanban/`) teaches pi the
workflow contract: card per unit of work, advance it through lanes, never leave stale cards.

## Scripts

| script | does |
| --- | --- |
| `bun run dev` | api (`:4600`, watch) + web (`:5174`) |
| `bun run build` | production web build → `web/dist` |
| `bun run start` | serve api + built web on `127.0.0.1:4600` |
| `bun test` | db + cli tests (temp DBs) |
| `bun run check` | svelte-check + tsc |

## Layout

```
src/            db.ts (sqlite + queries) · app.ts (elysia) · index.ts (server)
                cli.ts + render.ts (CLI) · search.ts · autoreview.ts (auto agents)
                thread.ts · restart.ts + shutdown.ts · skills.ts + models.ts
web/            Svelte 5 SPA (board, drag & drop, detail, settings)
skills/pi-kanban/  pi skill (source of truth)
data/kanban.db  your board (gitignored; KANBAN_DB overrides)
```
