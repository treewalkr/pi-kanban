# kanban

A local-first kanban board for the [pi](https://github.com/badlogic/pi-mono) coding agent.
One SQLite file, one command to serve: a web UI for you, a CLI for your agents —
and an agent loop that plans, builds, and reviews cards while you approve the plans.

## Quickstart

```bash
git clone https://github.com/treewalkr/pi-kanban && cd pi-kanban
bun install
bun run build            # web/dist once (skip while CLI-only)
./scripts/install.sh     # `kanban` into ~/.bun/bin + installs the pi skill
kanban serve --agents --open   # web UI at http://127.0.0.1:4600 — backgrounds itself (kanban ps | kanban stop)
```

Bun · Elysia (API, `4600`, localhost-only) · Svelte 5 runes · `bun:sqlite` (WAL).
The CLI writes the DB directly — agent-side CRUD needs no server; the UI updates live over SSE.

## The agent loop

`serve --agents` runs headless `pi` sessions over the board. Every step lands as a
thread comment (`kanban brief <id>` is the pickup context); each spawn logs to the
serve terminal under `[autoreview]`.

| role | does |
| --- | --- |
| `pi-elaborator` | expands terse notes into intent + acceptance criteria (`--elaborate`, or ✨) |
| `pi-planner` | writes each Plan-lane plan; open questions park the card in **Waiting on you** |
| `pi-plan-reviewer` | checks plans against the template; a pass parks it for your gate |
| **you** | `kanban approve` arms the builder; `reject --message` re-plans — the gate is human-only |
| `pi-builder` | builds the approved plan, tests, hands off to review |
| `pi-reviewer` | reviews; approve → Done, block → a findings checklist the builder works |

Dead sessions post the reason and offer a **↻ resume session** button that continues the
same pi session — no lost reasoning, no restart from scratch.

**Engines** decide what runs: each is a harness (pi or Claude Code), its model and
thinking level, and a number of seats (concurrent sessions). Every actor has a *runs on*
lineup of engines — the first enabled engine with a free seat wins, the rest are
fallbacks; a quota or auth failure cools every engine on that provider account. A project
can replace an actor's lineup, and `KANBAN_ENGINE=<id|name>` pins every spawn to one
engine (debugging). `kanban explain <actor> [--project p]` prints the chain for the next
spawn; `kanban engine ls|add|set|rm` manages the registry (also Settings → Engines).
Skills, context and timeout stay per actor and apply on the next spawn.

## The board

- Lanes **Backlog → Plan → Test + Implement → Review → Done → Archive** — customizable, with per-lane WIP limits
- **Waiting on you**: an agent's question parks a card with a `↩ from <lane>` chip; any human reply returns it
- Epics → stories → subtasks, each moving independently; age chips; done cards auto-archive (default 7 days)
- Per-card chat threads, plus a board-manager chat that dispatches per-lane workers
- Plan gate: versioned plan attachments, `kanban diff` between versions, human-only approve/reject
- Ownership (`kanban claim`), `kanban stats` analytics, board-health `kanban check` (flags a stale serve too)
- Browser notification when a card enters Review; set `KANBAN_OSASCRIPT_NOTIFY=1` for a macOS notification too

## CLI

```bash
kanban add <title> --project my-app [--note <text>] [--parent <id>] [--elaborate]
kanban ls · search <query> · show <id> · next · overview
kanban mv <id> <lane> · edit <id> … · done <id> · archive <id> · undo · rm <id> --force
kanban claim <id> · ws <id> <branch> · worker run <lane> · worker ls
kanban attach <id> <plan-file> · diff <id> <name> · approve <id> · reject <id> --message <text>
kanban lane ls | add | rename | rm | limit <ref> <n|off>
kanban stats [id] · check [--port <n>] · ps · stop · help
```

Ids accept any unique prefix; lanes accept slug, prefix, name, or ordinal; `--json`
everywhere; notes render GitHub-flavored markdown. `kanban help` lists everything.

One server per port; `kanban stop` and Settings → Service **restart** drain in-flight
agent sessions cleanly. When serve lags the checkout the header shows a `⟳ stale` chip —
the restart button rebuilds the web bundle and self-respawns onto it.

## pi skill

`skills/pi-kanban/SKILL.md` (installed to `~/.pi/agent/skills/pi-kanban/`) teaches pi the
workflow contract: card per unit of work, advance it through lanes, never leave stale cards.

## Scripts & layout

| script | does |
| --- | --- |
| `scripts/install.sh` | `kanban` bin + pi skill + git gate wiring (`git config core.hooksPath scripts/hooks`) |
| `bun run dev` | api (`:4600`, watch) + web (`:5174`) |
| `bun run build` | production web build → `web/dist` |
| `bun run start` | serve api + built web on `127.0.0.1:4600` |
| `bun test` | db + cli tests (temp DBs) |
| `bun run check` | svelte-check + tsc |

```
src/            db.ts (sqlite + queries) · app.ts (elysia) · index.ts (server)
                cli.ts + render.ts (CLI) · search.ts · autoreview.ts (auto agents)
                engines.ts (lineups) · claude.ts + agent-child.ts (harnesses)
                thread.ts · restart.ts + shutdown.ts · skills.ts + models.ts
web/            Svelte 5 SPA (board, drag & drop, detail, settings; Lucide icons)
skills/pi-kanban/  pi skill (source of truth)
data/kanban.db  your board (gitignored; KANBAN_DB overrides)
```
