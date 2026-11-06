---
name: pi-kanban
description: Track and manage task state on the Kanban board (Waiting on you → Backlog → Plan → Test + Implement → Review → Done → Archive) using the kanban CLI. Use when starting, planning, or finishing a unit of work; when the user mentions tasks, the board, kanban, backlog, "what's next", or moving work forward; to review what's in flight; and to set the skill up in a project ("pi-kanban init").
---
> Requires the kanban CLI — install it from this repo:
> https://github.com/treewalkr/pi-kanban (`git clone https://github.com/treewalkr/pi-kanban && cd pi-kanban && ./scripts/install.sh`)

# Kanban board

One global task board stored in SQLite, shared by the `kanban` CLI and a web UI
(`kanban serve --open` → http://127.0.0.1:4600). The CLI writes the database
directly — the web server does **not** need to be running.

## Init — wiring a project to the board

Once per project, when the user asks to set up pi-kanban (`pi-kanban init`):
make sure the CLI runs (`kanban version`; else see the install note above), then
add a short pointer section to the project's root `AGENTS.md` — create the file
if there is none. Insert this block, substituting the repo name for `<repo>`
(and the actual install path if it differs):

```markdown
## Task workflow

All non-trivial units of work run through the shared kanban board — follow the
`pi-kanban` skill (`.agents/skills/pi-kanban/SKILL.md`); load it before starting,
advancing, or finishing any task. Tag cards `--project <repo>`.
```

- **Idempotent**: if `AGENTS.md` already references this skill, don't insert a
  second section — fix the existing pointer only if it's stale.
- **Pointer only**: the section stays 3–4 lines; workflow detail lives in this
  skill, never in `AGENTS.md`.
- **Respect the file**: place the section to fit the file's structure and never
  reformat existing content; if the project's conventions clash with the block,
  propose an adaptation instead of forcing it in.

## Workflow contract

Keep the board truthful as you work. Lanes and their meaning, in order:

1. **Waiting on you** — HITL tickets parked for a human answer; replying returns them
2. **Backlog** — captured but not started
3. **Epics** — approved epics supervising their children (a card with children plans work, never builds; it auto-dones when nothing is in flight)
4. **Plan** — scoping/design before code
5. **Test + Implement** — actively building (test as you go)
6. **Review** — code done, verifying / awaiting user acceptance
7. **Done** — finished
8. **Archive** — kept for reference, out of the active board

The HITL rule: HITL tickets never resolve without the human — the agent never answers its own questions. When an agent needs human direction or a plan decision, it asks with `kanban comment <id> "<problem + recommended default>" --kind question` (each question with a recommended default). Posting a `question` comment atomically parks the card in **Waiting on you** (saving its home lane). A plan-review **pass** parks the card the same way (home lane: Plan). Any human comment (author not `pi-*`, kind not `question`) atomically returns the card to its home lane at the end. Agents never move parked cards. The plan gate (`approve`/`reject`) works directly on a card parked from Plan — no reply needed first.

For every non-trivial unit of work:

- **Before starting**: ensure a card exists and sits in the lane matching what
  you're about to do (`add` → `mv plan` when planning, `mv implement` when coding).
- **Pickup**: run `kanban overview` first — lane counts, WIP limits, and who owns
  what in one cheap read (never card bodies). Then `kanban brief <id>` before
  starting work on a card — note, latest plan, and full thread in one read.
- **Claim what you build**: when you start a card, `kanban claim <id> --author <name>`
  (or just `handoff` into Test + Implement, which sets the owner for you). Ownership
  is advisory but visible — `overview`, `ls --owner <name>`, and `show` all display it;
  any move out of Test + Implement clears it. A foreign owner needs `--force` to take over.
- **As you progress**: advance the card (`mv implement`, then `mv review` when
  the work looks complete). When you start Implement, attach your plan:
  write it to a file and `kanban attach <id> <plan-file>` — re-attaching a
  revised plan versions it (latest wins). Write plans with
  [plan-template.md](plan-template.md): every section filled or `N/A — reason`,
  every acceptance criterion mapped to concrete tests at named seams.
  Record the workspace on its card right after creating it: `kanban ws <id> <slug>` — the
  board shows it while the branch/worktree exists; nothing to clear after `done`
  (it disappears once git no longer has it).
- **Put-down**: `kanban handoff <id> <lane> --message <what you did · what's
  next> --author pi` when stopping or passing the card on — never a bare `mv`
  between actors; the message is the durable record.
- **Review**: `review --approve` (→ Done) or `review --block --message …
  --finding …` (→ Implement); findings land as `- [ ]` checklist lines on the
  note that the builder works through.
- **After acceptance**: `mv done` (or `done <id>`).
- **When a finished card is worth keeping but Done is getting crowded**:
  `archive <id>`. Undo with `kanban undo` (or `mv <id> <lane>`). Done cards also archive
  themselves after N days — tune it with `archive auto [<n>|off]` (default 7,
  `off` disables).
- **If work is rejected, abandoned, or superseded**: leave the one-line
  reason and archive — see **Out-of-scope memory** under Conventions;
  delete (`rm`) only noise. The board must reflect reality, including what
  was said no to and why.

## Auto-plan loop

With `kanban serve --agents`, pi agents also watch the Plan lane: a **planner** writes a
versioned plan for every card, a **plan reviewer** checks it against the shared checklist, and
a passing card then parks in **Waiting on you** at the gate. **The human owns the gate** — never run
`kanban approve`/`reject` as an agent.

- **Planning**: don't hand-write plans for Plan-lane cards in auto mode — the planner does it,
  using the shared template (`plan-template.md` next to this skill): every section filled or
  `N/A — reason`, every acceptance criterion mapped to concrete tests at named seams. Plans are
  written for a literal executor, so a frontier planner can hand off to a smaller, faster builder:
  a Step 0 baseline, then Files / Do / Check / Commit per step with paste-ready code and an
  expected Check result, all verified by running. A card whose note doesn't state user-perspective behavior isn't
  planner-ready — the planner asks instead of planning, and grounding starts
  with a redundancy check against existing code (see **Backlog readiness**
  under Conventions). If an answer would
  genuinely change the plan, the planner posts a `question` comment (each question with a
  recommended default) and stops; any human reply re-arms it — "use the defaults" counts.
  To force a re-plan: `kanban reject <id> --message <what to change>`; the next version lands
  as plan v2, v1 stays on the card.
- **Plan review**: the planner's handoff comment arms `pi-plan-reviewer`, which checks the plan
  against the template checklist and records exactly one verdict — `kanban plan-review <id>
  --pass --message …` (card parks in **Waiting on you** at the human gate) or `--block --message … --finding …`
  (planner re-plans with the findings). After 2 blocks without a human comment in between it
  caps out and leaves the card for you.
- **Approving** (`kanban approve <id>`, or ✓ in the web card — both work on a card parked in
  **Waiting on you** from Plan): approval comment + move to
  Implement; a `pi-builder` session builds the attached plan, runs tests, and hands off to
  Review, where the reviewer loop takes over.
- **Chat-approved plans** (fast path): when the human approves a plan you presented in the
  live session ("go ahead", "build it"), the gate has already done its job in chat. Attach
  the plan exactly as presented, record the verdict in the thread (`kanban comment <id> "plan
  approved in chat, <date> — attached plan is what was approved"`), and `mv <id> implement`.
  Never park the card in Plan first — the planner would adopt it — and never run
  `kanban approve`/`reject` yourself; if the plan changes materially after the approval, use
  the normal Plan-lane cycle instead. Hand off to Review as usual when the build is done.
- **If a plan-review session dies without a verdict** (quota, crash) or cannot evaluate the plan,
  it leaves a `comment` from `pi-plan-reviewer`; any human comment re-runs the **plan reviewer** on
  the attached plan as-is — no re-plan. (The cap-out comment works the same way.) After a pass or a
  planner question, a human comment re-arms the **planner** instead.
- **Each planner or plan-review cycle needs a human action** — no human comment, no re-runs.

## Auto-review loop

When the board runs with `kanban serve --agents`, a separate pi reviewer
watches the Review lane and code-reviews every card that arrives there — don't
review your own work in that mode unless asked.

- **Handing off to Review**: always `kanban handoff <id> review --message …
  --author pi`. The reviewer only picks up a card whose last thread comment
  isn't its own, so a bare `mv` into Review can sit unreviewed.
- **If the review blocks** (`pi-reviewer` review comment, card back in
  Test + Implement, `- [ ]` findings on the note): fix every finding, run the
  tests, check findings off by rewriting the note (`kanban edit <id> --note`),
  then `kanban handoff <id> review --message … --author pi-builder` — the
  reviewer re-reviews automatically. After 3 block cycles it stops and leaves
  the card for the user.
- **Verdicts** are `review` comments from `pi-reviewer`; approve moves the
  card to Done. If a review session failed, a comment says so — add any
  comment to the card to re-arm it.

## Lane workflows (lane contexts)

Every workflow lane carries an optional **lane context** — the declarative rules the
auto-agent loop interprets: an ordered **actor chain** (each with a `pi-` author, prompt
instructions supporting `{id}` / `{title}` / `{tmpFile}`, and per-actor model settings), an
optional artifact + **template**, **trigger** rules (arm on lane entry / on a human
comment / on a matching comment), **exit** rules (a verdict comment → arm the next actor,
re-run the first, move/park the card, or disarm), the human-only **gate**
(`approve`/`reject` targets), and a **cap** (max auto-cycles before the card parks for a
human). The default plan → implement → review pipeline is just the seeded configuration of
the `plan`, `implement`, and `review` lanes — a custom lane needs zero code changes:

```
kanban lane add Design
kanban lane context design --actor designer --author pi-designer --instructions "Design card {id} \"{title}\" against the template" \
  --template @skills/pi-kanban/design-template.md --artifact design --approve-to plan --cap 2
kanban lane context design            # view it (--json for machine-readable)
kanban lane context design --clear    # remove the workflow (cards pass through untouched)
```

- Configure the seeded pipeline's agents on their lanes: web UI → ≡ → **Agents** → pick a
  lane (or the ⚙ on any lane header); `agent_configs` and the lane actors stay in sync.
- Verdict prefixes an actor's exit rules match are freeform (e.g. `design: pass`); the
  seeded lanes match `plan review: pass/block` and the review verdicts.
- Gates stay human-only: agents never run `approve`/`reject`/`plan-review`/`review` on a
  lane they don't own, and every gate is still a human action.
- `kanban plan-review`, `approve`, and `reject` work on any lane whose context hosts a
  gate/artifact — a Design lane's reviewer parks cards the same way the plan reviewer does.

## Board manager and lane workers

The board chat in the web UI (sidebar → **Board chat**) talks to the **board manager** — a
resident agent with a board-wide view (lane counts, aging, what's parked, what's next). It
proposes per-lane sweeps and runs them only when you say go, then relays the workers' summaries.

**Lane workers** are short-lived headless agents, one charter per lane, dispatched from board
chat or the CLI:

```
kanban worker run <lane> [--focus <text>] [--author <name>]   # queue a run; drained by serve --agents
kanban worker ls [--lane <ref>] [--json]                      # runs: id · lane · status · age · summary
```

- **Backlog** is the only writable charter: groom titles/notes/tags, rank with `mv --next`/`--prev`,
  ask clarifying questions (`comment --kind question` parks the card), promote at most 3 ready
  cards to Plan per run. Never deletes; never invents scope.
- **Waiting / Plan / Test + Implement / Review** workers are report-only: a summary for the
  manager, nothing written to the cards (the loop owns those threads).
- Workers read at most 12 cards (`kanban brief`), write at most 10 changes, run under a
  15-minute timeout, always `--author pi-worker-<lane>`, and **never run `approve`, `reject`,
  `review`, or `plan-review`** — gates stay human-only. Runs are visible in the web UI's
  Agents settings ("lane workers") and via `worker ls`.

## Commands

```
kanban add <title…> [--note <text>] [--lane <ref>] [--project <tag>] [--tag <tag>]… [--parent <id>] [--priority <high|normal|low>] [--blocked-by <id>]… [--top]  # new card (Backlog by default; --parent nests it)
kanban overview [--json]                                              # the cheap one-read board shape: lane counts, WIP limits, owned cards (no card bodies)
kanban ls [lane] [--project <tag>] [--tag <tag>]… [--owner <name>] [--json]      # board overview / one lane (children indented; ▲▼ priority, ⊘ blocked, ☉ waiting; caps at 10 rows/lane, 50 in single-lane view, `… +K more` points at --json)
kanban next [--project <tag>] [--json]                           # what's next: lane priority, then card priority, then oldest; skips blocked (prints blocked & waiting counts)
kanban search <query…> [--project <tag>] [--tag <tag>]… [--limit <n>] [--json]        # ranked matches (default 20 rows, --limit ≤ 50); --json: {results, matched, hasMore, hint?}
kanban show <id>                                                      # full detail incl. note, plan, parent, subtasks, blockers, from-lane, owner
kanban claim <id> [--author <name>] [--force]                         # record who's building it (foreign owner refuses without --force)
kanban link <id> <other> · unlink <id> <other>                        # relate / unrelate two cards (undirected; visible from both)
kanban attach <id> <file|gh-ref> [--as <name>]                        # attach/version a card file (default name: plan), or link a GitHub pr/issue: <pr-url|issue-url|gh:owner/repo#n> (--as is files-only); show prints the latest
kanban gh unlink <id> <ref>                                           # remove a GitHub link (ref: url, gh:owner/repo#n, or #n)
kanban import gh:<owner>/<repo> [--limit <n>]                         # seed Backlog from the repo's open GitHub issues (url-deduped, limit ≤ 200)
kanban files <id>                                                     # card files: name · vN · size · source
kanban cat <id> <name> [--v <n>]                                      # print a file's content (latest, or a given version)
kanban diff <id> <name> [--from <n>] [--to <n>]                      # unified diff between two versions (default: latest pair)
kanban ws <id> <branch>                                               # record/clear where the card's implementation lives (--clear to unset)
kanban comment <id> <text…> [--author <name>] [--kind <comment|review|handoff|question>]  # append to the card's thread (question parks the card)
kanban comments <id>                                                  # read the thread, oldest first
kanban handoff <id> <lane> --message <text> [--author <name>]         # atomic move + thread record (the baton pass)
kanban review <id> (--approve | --block --message <text> [--finding <text>]…)  # approve → Done; block → Implement + findings
kanban approve <id>                       # plan gate: approve the attached plan → Implement (arms plan-build; works on Waiting-on-you cards parked from Plan)
kanban reject <id> --message <feedback>   # plan gate: reject with feedback → planner re-plans (a parked card returns to Plan first)
kanban brief <id>                                                     # full pickup context: note, latest plan, files, thread
kanban mv <id> <lane> [--pos <1-based> | --before <id>]               # move / reorder (--before <anchorId> is concurrent-safe where --pos drifts; same-lane mv without either is a free no-op)
kanban mv <id> --next | --prev                                        # advance / pull back one lane
kanban edit <id> [--title <t>] [--note <text>] [--project <tag>] [--tag <tag>]… [--lane <ref>] [--parent <id>] [--priority <high|normal|low>] [--blocked-by <id>]… [--clear-blocked-by] [--clear-tags] [--clear-note] [--clear-parent]
kanban done <id>                                                      # shortcut → Done
kanban archive <id>                                                   # shortcut → Archive (undo: mv <id> <lane>)
kanban undo [id] [--json]                                             # revert the last lane move (board-wide, or for one card)
kanban archive auto [<n>|off]                                         # done cards auto-archive after N days (default 7; off disables)
kanban check [--json]                                                 # board-health lint: done parents w/ active children, children behind parent, planless build cards (advisory, exit 0)
kanban stats [id] [--json]                                           # board summary, or one card's lane times / cycle / gate metrics
kanban rm <id> [--force]                                              # delete card (a parent needs --force; cascades)
kanban lane ls | add <name> | rename <ref> <name> | rm <ref> [--force]  # manage lanes
kanban lane context <ref> [--json] [--clear] [--from <file>]          # a lane's workflow: actors, instructions, template, triggers, exits, gate, cap
kanban lane context <ref> --actor <id> --author <pi-name> --instructions <text|@file> [--template <text|@file>] [--artifact <name>] [--approve-to <lane>] [--cap <n>] [--test-gate]  # create/patch a lane workflow
kanban serve [--port <n>] [--open] [--agents] [--fg]  # start web UI (default 127.0.0.1:4600); backgrounds itself (kanban ps / kanban stop); --agents: pi plans Plan-lane cards and reviews Review-lane cards
kanban ps [--json]                                                    # running serves on any port + their live agent sessions + abandoned leases
kanban help | version                                                 # CLI help / version
```

## Conventions

- **Backlog readiness**: a card is planner-ready only when its note states
  the user-perspective behavior — what changes end-to-end for the person
  using the board, not a list of layers to touch. A note that reads like
  an implementation sketch isn't ready: rewrite it before planning (the
  planner asks a `question` instead of planning it).
- **Redundancy check** (part of readiness): before planning, search the
  repo (`rg`, `kanban search`) for an existing implementation of the note's
  stated behavior and cite where you looked — plan around what already
  exists instead of re-building it.
- **Out-of-scope memory**: rejected or abandoned cards carry a one-line
  reason (`kanban comment <id> "out of scope: <why>"`) before leaving the
  board, then `archive <id>` — the thread is searchable, so "we already
  said no, and why" stays one `kanban search` away and the same idea
  doesn't relitigate. Delete (`rm`) only noise: accidental captures,
  near-simultaneous dupes, test cards — anything whose rejection carries
  no lesson.
- **Task ids**: any unique prefix works (`kanban show k7x`). Use full ids in
  scripts, prefixes interactively.
- **Lane refs**: slug (`backlog`), unique prefix (`imp`), name prefix (`Rev`),
  or ordinal (`1`–`n` in board order).
- **`--project`**: tag cards with the repo name (`--project kanban`) so the
  board stays scannable across projects; filter with `kanban ls --project X`
  or the chips in the web UI.
- **`--tag`**: tags are free-form cross-cutting labels (`ui`, `review-loop`,
  `quick-win`), multiple per card. Filter with `ls --tag X --tag Y` (repeats
  AND) or `search --tag X`; set via `add`/`edit --tag` (replace), clear with
  `edit --clear-tags`.
- **`--parent`**: nest a card under another (epic → story → subtask, max depth
  3). `add --parent <id>` defaults the child to the parent's lane;
  `edit --parent <id>` reparents, `edit --clear-parent` detaches. Each card
  still moves through lanes **independently** — finishing a parent never
  auto-finishes children, so advance subtasks as you complete them (`done` on
  each). `rm` on a parent with children refuses without `--force`, which
  deletes the whole subtree. The web UI nests same-lane children under the
  parent card with a `2/3 ✓` progress badge; `show <id>` prints the tree.
- **`--priority`**: `high` | `normal` (default) | `low` — the triage tier. It
  is a badge and a `next` input, not a sort: within a lane, `next` proposes
  high before normal before low (then oldest). Shows as ▲/▼ chips in the web
  UI and `ls`; set via `add`/`edit --priority`, or the toggle in the web
  editor.
- **`--blocked-by`**: prerequisite edges — `add`/`edit --blocked-by <id>`
  (repeatable; on `edit` it **replaces** the set, `--clear-blocked-by` empties
  it). Blocking is soft: a card is blocked while any blocker sits outside Done
  or Archive; finishing the blocker unblocks it (the edge stays, for history).
  Self-edges and cycles are refused. Blocked cards print ⊘ in `ls`/`show` and
  dim in the web UI; `mv` into Plan/Implement warns but never refuses;
  `next` skips them and prints how many. The auto-agent loop also holds blocked
  cards — no lane agent spawns and no dead session resumes while any blocker
  sits outside Done/Archive, AI note elaboration still runs, and finishing the
  last blocker (a board write) makes the loop pick the card up with no new
  comment. Edges map dependencies — they don't gate moves or auto-finish anything.
- **Links (`kanban link <id> <other>`)**: general undirected relations
  between cards (`kanban unlink <id> <other>` removes). Links are undirected,
  idempotent, visible from both cards in CLI and web detail, survive moves,
  and die with either card. Unlike `--blocked-by`, links never gate moves,
  never soft-block, and have no cycle restrictions.
- **`--note`**: free text, rendered as GitHub-flavored markdown in the web UI —
  handy for acceptance-criteria checklists (`- [ ] …`), tables, code snippets,
  links. For multi-line notes from a shell, pass the text through a quoted
  heredoc so backticks and quotes survive:
  `n=$(cat <<'EOF' … EOF); kanban edit <id> --note "$n"`.
- **`lane rm --force`** deletes the lane *and every card in it* — it does not
  relocate them. Move cards out first unless you mean to drop them.
- **Plans & card files**: `kanban attach <id> <plan-file>` stores the file's
  text on the card (source path kept as metadata); attach again to version it.
  `show <id>` prints the latest plan plus a `files:` inventory, and the web UI
  shows them as collapsed markdown sections in the card detail — the plan lives
  on the card, not in a scratch file. Search matches plan text too. Any other
  text artifact attaches under a name: `kanban attach <id> <file> --as <name>`
  (design docs, repro logs, review notes, API contracts). Names are lowercase
  kebab with an optional extension — `design`, `repro-log.txt` — pick a stable
  descriptive name and keep it across revisions (re-attaching versions it);
  invalid names are rejected with the rule in the error. Read one back with
  `kanban cat <id> <name> [--v <n>]`; a wrong name lists what the card has.
  Compare versions with `kanban diff <id> <name>` — it defaults to the newest
  pair, so "what changed after the block/rejection" is one command
  (`--from`/`--to` for any pair; the web detail has a per-file diff toggle).
  `session` is reserved for the agent loop.
- **Threads**: every card carries a comment thread — the card *is* the forum.
  Kinds: `comment` (default), `review`, `handoff`, `question` (agent asking you something — parks the card in Waiting on you; any human reply returns it),
`approval`, `rejection` (gate verdicts, human-only). `--author` names the writer:
  agents pass their name (`--author pi`), humans and the web UI default to
  `user`. The web card detail shows the thread live. Card chat (the web UI's
  chat section) writes through the same thread verbs as `--author pi-chat` —
  its board writes land as ordinary thread entries; approve/reject stay
  human-owned.
- **Ownership (`owner`)**: one visible fact for "who's on this". `handoff` into
  Test + Implement sets it to `--author ?? user`; `review --block` sets it to
  the implement lane's lead actor (`pi-builder`), never the reviewer; `approve`
  sets it to `pi-builder`; leaving Test + Implement (mv, done, archive, park)
  clears it. `kanban claim <id>` sets it manually; a foreign owner refuses
  without `--force`.
- **Board notice**: `scripts/install.sh` symlinks `src/notice.ts` into
  `~/.pi/agent/extensions/kanban-notice.ts` — every pi session gets one
  `display:false` `[kanban board]` message at start and again only when the board's
  shape changes. `KANBAN_NOTICE=0` disables it; `KANBAN_NOTICE_INTERVAL_MS` (min
  1000) lengthens the poll. It reads via the installed CLI and never creates a
  board file that does not exist.
- **`--json`**: append to any command for machine-readable output; on error the
  CLI exits 1 and prints `kanban: <message>` to stderr. `search --json` returns
  the envelope `{results, matched, hasMore, hint?}` — compact rows, never full
  cards — so narrow the query instead of paging.
- The web UI edits the same database and receives pushed updates (SSE), so
  CLI and browser changes stay in sync automatically. Clicking a card opens a
  detail view (full note, timestamps, quick done/archive actions) with an edit
  mode.
  Archive shows as a collapsed strip at the end of the board — click to expand,
  or drag a card onto it to archive.
- First run of a command creates `data/kanban.db` in the app repo and seeds the
  seven default lanes (Waiting on you / Backlog / Plan / Test + Implement /
  Review / Done / Archive). Lanes are customizable — `lane add`/`rename`/`rm` —
  but waiting comes first, done and archive stay last; they are fixed, as is
  `backlog`.

## When the user asks "what's next" / to plan the day

Run `kanban next` (add `--project <repo>` on a shared board; `--json` for scripts):
it prints the proposed card — first match by lane priority (Review →
Test + Implement → Plan → Backlog); within the lane, `high` beats `normal`
beats `low`, then oldest first. Cards with unfinished blockers are skipped
and the count printed — unblock them (finish the blocker) or pick from
`kanban ls`. Done, Archive, custom lanes, and Waiting on you are never proposed;
an empty answer means the board is clear. When cards are parked, `next` prints
`☉ N waiting on you` (human work, not agent work). `kanban brief <id>` picks
the proposal up from there. For a fuller picture, run `kanban ls` and summarize
per lane.
