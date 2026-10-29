# kanban

A local-first Kanban board for the [pi](https://github.com/badlogic/pi-mono) coding agent to
track task state — one SQLite file, a web UI for humans, and a CLI for agents.

Lanes default to the working workflow — **Backlog → Plan → Test + Implement → Review → Done →
Archive** — and are customizable. Archive keeps finished cards out of the way: a collapsed strip
on the board (click to expand, drag onto it to archive), `kanban archive <id>` from the CLI.

Cards nest into an **epic → story → subtask** hierarchy (max depth 3). Same-lane children render
collapsed under their parent with a `2/3 ✓` progress badge; a child in another lane renders as a
normal card linked to its parent. Every card still moves through lanes independently — finishing
a parent never finishes its children.

## Stack

Bun · Elysia (API, port `4600`) · Svelte 5 runes SPA (Vite, dev port `5174`) · Eden Treaty ·
`bun:sqlite` (`data/kanban.db`, WAL). The CLI talks to SQLite directly, so the server never
needs to be running for agent-side CRUD.

## Install

```bash
bun install
bun run build          # builds web/dist once (skip while only using the CLI)
./scripts/install.sh   # symlinks `kanban` into ~/.bun/bin + installs the pi skill
```

## Use

```bash
kanban serve --open            # web UI at http://127.0.0.1:4600
bun run dev                    # hacking: api watch + vite dev server
```

One server at a time: `serve` refuses to start when the port is already taken
(and agent work is leased per card in the DB, so stray processes can't double-
plan a card). A restart drains first — in-flight agent sessions are terminated
cleanly, never orphaned.

Settings → General → **Service** carries a **restart service** button (web UI and API alike):
one click rebuilds `web/dist` (`bun run build`) and restarts the server — under `bun run dev`
it reloads the watched API via a marker rewrite, under `kanban serve` the process drains
its agent sessions and respawns itself. While agent sessions run, the restart is refused
with a confirm (force overrides). The board reconnects automatically once the server is
back. Local pages only: cross-origin requests are refused.

```bash
kanban add Fix login redirect --note "bounces to / after oauth" --project my-app
kanban mv <id> plan            # or --next / --prev
kanban ls [--project my-app] [--json]
kanban next [--project my-app]      # what's next: lane priority, then card priority, then oldest; skips blocked
kanban search <query> [--project my-app]   # ranked: titles, checklist lines, notes
kanban add Write e2e tests --parent <id>   # subtask — inherits the parent's lane
kanban edit <id> --parent <id> · --clear-parent
kanban show <id> · done <id> · archive <id> · edit <id> …
kanban rm <id> --force         # deleting a parent cascades its subtree
kanban lane ls | add | rename | rm
```

Task ids accept any unique prefix; lanes accept slug, prefix, name, or ordinal.
`--json` everywhere for agent consumption; errors exit 1 with `kanban: <message>` on stderr.
`ls` indents same-lane children under their parent; `show` prints the full tree with each
child's lane. Notes render GitHub-flavored markdown in the web UI (lists, checkboxes, code,
links).

### pi agent

The skill in `skills/pi-kanban/SKILL.md` (installed to `~/.pi/agent/skills/pi-kanban/` by
`scripts/install.sh`) teaches pi the workflow contract: card per unit of work, advance it
through lanes, never leave stale cards. The CLI writes the DB directly; the server watches the
database and pushes changes to the web UI over SSE, so the board updates live.

### Auto agents (plan + review)

`kanban serve --auto-review` runs four headless `pi` agents over the board. **Auto-plan**: a
`pi-planner` picks up every card in the Plan lane, explores the repo, and attaches a versioned
implementation plan written from the shared template ([plan-template.md](skills/pi-kanban/plan-template.md));
when an answer would genuinely change the plan it asks first (`question` comments, each with a
recommended default) and waits for your reply. A `pi-plan-reviewer` then checks every plan
against the template's review checklist before the human gate — block bounces back to the
planner with findings (max 2 rounds per human comment, then the card waits for you), pass leaves
it at the gate. The human owns the gate — `kanban approve <id>` (or ✓ in the web card) arms
a `pi-builder` session that builds the plan, `kanban reject <id> --message <feedback>` (or ✗)
sends the feedback back to the planner for plan v2. **Auto-review**: a `pi-reviewer` reviews
every card that lands in Review — approve → Done, block → findings land as a `- [ ]` checklist
and a `pi-builder` session works them and hands the card back (stops after 3 block cycles and
leaves a comment for you). Every step is a thread comment, and each spawn is logged in the serve
terminal under `[autoreview]`. Each agent spawn gets its own fresh pi session — the card thread
(`kanban brief`) is the only shared context. If a session dies (model error, quota limit, timeout, or
silent exit), the reason and duration are posted to the card thread, an `✗ session died` badge marks
the card on the board, and any diagnostic stderr tail is saved in the session attachment. When a
session dies, a **↻ resume session** button appears on the card's detail/activity panel: clicking it
re-spawns pi continuing the same session (`--session-id` keyed to the card's recorded session),
re-acquiring the lease, clearing the dead badge, and streaming into the live activity log — preserving
earlier reasoning and tokens instead of starting from scratch. Commenting on the card remains a fresh
re-run. If the session file in `~/.pi` is missing, resume safely falls back to a fresh session under the same ID.

Configure all four agents in the web UI (⚙ in the topbar) — settings apply to the next session
without restarting serve:

| field | becomes | notes |
| --- | --- | --- |
| provider / model | `--provider` / `--model` | selects fed by pi's catalog (`pi --list-models`); empty = pi's default |
| thinking | `--thinking` | reviewer, planner and plan reviewer default to `max`, builder to pi's default |
| skills | `--skill` per line | e.g. `~/.pi/agent/skills/scrutinize` |
| context | `--append-system-prompt` | standing instructions, your review lens |
| tools | `--tools` | pi allow/deny syntax |
| extra flags | passed through raw | escape hatch |
| timeout | per-session kill | 1–60 min, default 20 |

Env overrides win over the stored config: `KANBAN_AUTOREVIEW_MODEL`, `KANBAN_AUTOREVIEW_THINKING`
(set to `""` to disable thinking entirely), and `KANBAN_AUTOREVIEW_MAX_PARALLEL` (concurrent sessions,
default 1, max 8). Reviewer/builder sessions run in the serve process's
directory and use the card's plan path and thread to locate the work.

## Scripts

| script | does |
| --- | --- |
| `bun run dev` | api (`:4600`, watch) + web (`:5174`) |
| `bun run build` | production web build → `web/dist` |
| `bun run start` | serve api + built web on `127.0.0.1:4600` |
| `bun test` | db + cli tests (uses temp DBs) |
| `bun run check` | svelte-check + tsc |

## Layout

```
src/    db.ts (sqlite + queries) · app.ts (elysia, type App) · index.ts (server)
        cli.ts + render.ts (kanban CLI)
web/    Svelte 5 SPA: board with nested subtask cards, drag & drop, card detail
        view, editor, filters
skills/pi-kanban/SKILL.md   pi skill (source of truth)
data/kanban.db           your board (gitignored; KANBAN_DB overrides, used by tests)
```
