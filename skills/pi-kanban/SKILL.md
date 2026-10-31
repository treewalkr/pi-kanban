---
name: pi-kanban
description: Track and manage task state on the Kanban board (Waiting on you → Backlog → Plan → Test + Implement → Review → Done → Archive) using the kanban CLI. Use when starting, planning, or finishing a unit of work; when the user mentions tasks, the board, kanban, backlog, "what's next", or moving work forward; and to review what's in flight.
---

# Kanban board

One global task board stored in SQLite, shared by the `kanban` CLI and a web UI
(`kanban serve --open` → http://127.0.0.1:4600). The CLI writes the database
directly — the web server does **not** need to be running.

## Workflow contract

Keep the board truthful as you work. Lanes and their meaning, in order:

1. **Waiting on you** — HITL tickets parked for a human answer; replying returns them
2. **Backlog** — captured but not started
3. **Plan** — scoping/design before code
4. **Test + Implement** — actively building (test as you go)
5. **Review** — code done, verifying / awaiting user acceptance
6. **Done** — finished
7. **Archive** — kept for reference, out of the active board

The HITL rule: HITL tickets never resolve without the human — the agent never answers its own questions. When an agent needs human direction or a plan decision, it asks with `kanban comment <id> "<problem + recommended default>" --kind question` (each question with a recommended default). Posting a `question` comment atomically parks the card in **Waiting on you** (saving its home lane). A plan-review **pass** parks the card the same way (home lane: Plan). Any human comment (author not `pi-*`, kind not `question`) atomically returns the card to its home lane at the end. Agents never move parked cards. The plan gate (`approve`/`reject`) works directly on a card parked from Plan — no reply needed first.

For every non-trivial unit of work:

- **Before starting**: ensure a card exists and sits in the lane matching what
  you're about to do (`add` → `mv plan` when planning, `mv implement` when coding).
- **Pickup**: run `kanban brief <id>` before starting work on a card — note,
  latest plan, and full thread in one read.
- **As you progress**: advance the card (`mv implement`, then `mv review` when
  the work looks complete). When you start Implement, attach your plan:
  write it to a file and `kanban attach <id> <plan-file>` — re-attaching a
  revised plan versions it (latest wins). Write plans with
  [plan-template.md](plan-template.md): every section filled or `N/A — reason`,
  every acceptance criterion mapped to concrete tests.
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
  `archive <id>`. Undo with `mv <id> <lane>`.
- **If work is abandoned or superseded**: delete the card (`rm`). Never leave
  stale cards behind — the board must reflect reality.

## Auto-plan loop

With `kanban serve --auto-review`, pi agents also watch the Plan lane: a **planner** writes a
versioned plan for every card, a **plan reviewer** checks it against the shared checklist, and
a passing card then parks in **Waiting on you** at the gate. **The human owns the gate** — never run
`kanban approve`/`reject` as an agent.

- **Planning**: don't hand-write plans for Plan-lane cards in auto mode — the planner does it,
  using the shared template (`plan-template.md` next to this skill): every section filled or
  `N/A — reason`, every acceptance criterion mapped to concrete tests. If an answer would
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

When the board runs with `kanban serve --auto-review`, a separate pi reviewer
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

## Commands

```
kanban add <title…> [--note <text>] [--lane <ref>] [--project <tag>] [--parent <id>] [--priority <high|normal|low>] [--blocked-by <id>]… [--top]  # new card (Backlog by default; --parent nests it)
kanban ls [lane] [--project <tag>] [--json]                           # board overview / one lane (children indented; ▲▼ priority, ⊘ blocked, ☉ waiting)
kanban next [--project <tag>] [--json]                           # what's next: lane priority, then card priority, then oldest; skips blocked (prints blocked & waiting counts)
kanban search <query…> [--project <tag>] [--json]                     # ranked matches: titles, checklist lines, notes, plans
kanban show <id>                                                      # full detail incl. note, plan, parent, subtasks, blockers, from-lane
kanban link <id> <other> · unlink <id> <other>                        # relate / unrelate two cards (undirected; visible from both)
kanban attach <id> <file> [--as <name>]                               # attach/version a card file (default name: plan); show prints the latest
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
kanban mv <id> <lane> [--pos <1-based>]                               # move / reorder
kanban mv <id> --next | --prev                                        # advance / pull back one lane
kanban edit <id> [--title <t>] [--note <text>] [--project <tag>] [--lane <ref>] [--parent <id>] [--priority <high|normal|low>] [--blocked-by <id>]… [--clear-blocked-by] [--clear-note] [--clear-parent]
kanban done <id>                                                      # shortcut → Done
kanban archive <id>                                                   # shortcut → Archive (undo: mv <id> <lane>)
kanban check [--json]                                                 # board-health lint: done parents w/ active children, children behind parent, planless build cards (advisory, exit 0)
kanban stats [id] [--json]                                           # board summary, or one card's lane times / cycle / gate metrics
kanban rm <id> [--force]                                              # delete card (a parent needs --force; cascades)
kanban lane ls | add <name> | rename <ref> <name> | rm <ref> [--force]  # manage lanes
kanban serve [--port <n>] [--open] [--auto-review]            # start web UI (default 127.0.0.1:4600); --auto-review: pi plans Plan-lane cards and reviews Review-lane cards
kanban help | version                                                 # CLI help / version
```

## Conventions

- **Task ids**: any unique prefix works (`kanban show k7x`). Use full ids in
  scripts, prefixes interactively.
- **Lane refs**: slug (`backlog`), unique prefix (`imp`), name prefix (`Rev`),
  or ordinal (`1`–`n` in board order).
- **`--project`**: tag cards with the repo name (`--project kanban`) so the
  board stays scannable across projects; filter with `kanban ls --project X`
  or the chips in the web UI.
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
  `next` skips them and prints how many. Edges map dependencies — they don't
  gate moves or auto-finish anything.
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
  `user`. The web card detail shows the thread live.
- **`--json`**: append to any command for machine-readable output; on error the
  CLI exits 1 and prints `kanban: <message>` to stderr.
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
