---
name: kanban
description: Track and manage task state on the Kanban board (Backlog → Plan → Test + Implement → Review → Done → Archive) using the kanban CLI. Use when starting, planning, or finishing a unit of work; when the user mentions tasks, the board, kanban, backlog, "what's next", or moving work forward; and to review what's in flight.
---

# Kanban board

One global task board stored in SQLite, shared by the `kanban` CLI and a web UI
(`kanban serve --open` → http://127.0.0.1:4600). The CLI writes the database
directly — the web server does **not** need to be running.

## Workflow contract

Keep the board truthful as you work. Lanes and their meaning, in order:

1. **Backlog** — captured but not started
2. **Plan** — scoping/design before code
3. **Test + Implement** — actively building (test as you go)
4. **Review** — code done, verifying / awaiting user acceptance
5. **Done** — finished
6. **Archive** — kept for reference, out of the active board

For every non-trivial unit of work:

- **Before starting**: ensure a card exists and sits in the lane matching what
  you're about to do (`add` → `mv plan` when planning, `mv implement` when coding).
- **Pickup**: run `kanban brief <id>` before starting work on a card — note,
  latest plan, and full thread in one read.
- **As you progress**: advance the card (`mv implement`, then `mv review` when
  the work looks complete). When you start Implement, attach your plan:
  write it to a file and `kanban attach <id> <plan-file>` — re-attaching a
  revised plan versions it (latest wins).
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

With `kanban serve --auto-review`, a pi planner also watches the Plan lane: every card there
gets a planning session that explores the repo and attaches a versioned plan, then comments
to disarm. **The human owns the gate** — never run `kanban approve`/`reject` as an agent.

- **Planning**: don't hand-write plans for Plan-lane cards in auto mode — the planner does it.
  To re-plan, `kanban reject <id> --message <what to change>` (or any human comment re-arms it);
  the next version lands as plan v2, v1 stays on the card.
- **Approving** (`kanban approve <id>`, or ✓ in the web card): approval comment + move to
  Implement; a `pi-builder` session builds the attached plan, runs tests, and hands off to
  Review, where the reviewer loop takes over.
- **Each planner cycle needs a human action** — no rejections, no planner runs.

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
kanban add <title…> [--note <text>] [--lane <ref>] [--project <tag>] [--parent <id>] [--top]  # new card (Backlog by default; --parent nests it)
kanban ls [lane] [--project <tag>] [--json]                           # board overview / one lane (children indented)
kanban search <query…> [--project <tag>] [--json]                     # ranked matches: titles, checklist lines, notes, plans
kanban show <id>                                                      # full detail incl. note, plan, parent, subtasks
kanban attach <id> <plan-file>                                        # attach/version a plan; show prints the latest
kanban comment <id> <text…> [--author <name>] [--kind <comment|review|handoff>]  # append to the card's thread
kanban comments <id>                                                  # read the thread, oldest first
kanban handoff <id> <lane> --message <text> [--author <name>]         # atomic move + thread record (the baton pass)
kanban review <id> (--approve | --block --message <text> [--finding <text>]…)  # approve → Done; block → Implement + findings
kanban approve <id>                       # plan gate: approve the attached plan → Implement (arms plan-build)
kanban reject <id> --message <feedback>   # plan gate: reject with feedback → planner re-plans
kanban brief <id>                                                     # full pickup context: note, latest plan, thread
kanban mv <id> <lane> [--pos <1-based>]                               # move / reorder
kanban mv <id> --next | --prev                                        # advance / pull back one lane
kanban edit <id> [--title <t>] [--note <text>] [--project <tag>] [--lane <ref>] [--parent <id>] [--clear-note] [--clear-parent]
kanban done <id>                                                      # shortcut → Done
kanban archive <id>                                                   # shortcut → Archive (undo: mv <id> <lane>)
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
- **`--note`**: free text, rendered as GitHub-flavored markdown in the web UI —
  handy for acceptance-criteria checklists (`- [ ] …`), tables, code snippets,
  links. For multi-line notes from a shell, pass the text through a quoted
  heredoc so backticks and quotes survive:
  `n=$(cat <<'EOF' … EOF); kanban edit <id> --note "$n"`.
- **`lane rm --force`** deletes the lane *and every card in it* — it does not
  relocate them. Move cards out first unless you mean to drop them.
- **Plans**: `kanban attach <id> <plan-file>` stores the file's text on the
  card (source path kept as metadata); attach again to version it. `show <id>`
  prints the latest plan, and the web UI shows it as a collapsed markdown
  section in the card detail — the plan lives on the card, not in a scratch
  file. Search matches plan text too.
- **Threads**: every card carries a comment thread — the card *is* the forum.
  Kinds: `comment` (default), `review`, `handoff`. `--author` names the writer:
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
  six default lanes (Backlog / Plan / Test + Implement / Review / Done /
  Archive). Lanes are customizable — `lane add`/`rename`/`rm` — but keep
  `backlog` and `done` at the ends; they are fixed, as is `archive`.

## When the user asks "what's next" / to plan the day

Run `kanban ls` (or `--json`), read Review first (awaiting acceptance), then
Test + Implement (in flight), then Plan, then Backlog. Skip Archive — it's
history, not work. Summarize per lane and propose the next card to pull
forward.
