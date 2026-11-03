# Kanban

A shared task board where humans and autonomous agents coordinate work from initial capture through planning, implementation, and review. The board serves as durable external memory so stateless agent sessions stay aligned with human intent.

## Language

**Card**:
A single unit of work on the board, carrying a title, note, attached files, and thread as it moves across lanes.
_Avoid_: Task, ticket, issue, item

**Card detail**:
The read-only modal for an open card (`TaskDetail.svelte`), live-derived from the board so external writes appear without a reopen; distinct from the **editor** (`TaskEditor.svelte`, `board.editMode`), which snapshots fields on open and pauses board refreshes.
_Avoid_: Card dialog, inspector, modal

**Lane**:
A named workflow stage on the board (`Waiting on you`, `Backlog`, `Plan`, `Test + Implement`, `Review`, `Done`, `Archive`) that holds an ordered list of cards.
_Avoid_: Column, state, status, stage

**Project**:
A label associating a card with a codebase or workstream so one shared board can filter work across multiple efforts.
_Avoid_: Board, namespace, repo tag

**Project route**:
The stored mapping from a project tag to a repo path (`projects` table) that
decides which repo a card's agents spawn in; un-routed tags fall back to the
serve launch dir. _Avoid_: repo mapping, project binding, workspace.

**Thread**:
The chronological conversation on a card where humans and agents record questions, handoffs, reviews, and gate verdicts.
_Avoid_: Activity log, comment feed, discussion, chat history

**Comment kind**:
The workflow role of a thread entry: `comment` (general note), `question` (agent question that parks the card in `Waiting on you` for a human reply), `handoff` (baton pass when changing actors or lanes), `review` (plan or code review verdict), `approval` (human gate pass), or `rejection` (human gate refusal with feedback).
_Avoid_: Message type, event type, note type

**Plan**:
A versioned implementation contract attached to a card in the `Plan` lane that two builders can follow to produce the same behavior.
_Avoid_: Spec, design doc, PRD, blueprint

**Seam**:
The public interface a test lives at — CLI surface, HTTP route, exported
function, or query function — named in the plan before the test is written;
internal helpers are never seams.
_Avoid_: Touchpoint, integration point, test surface

**Brief**:
The complete pickup view of a card combining its note, latest plan, attached file inventory, and full thread in one read.
_Avoid_: Summary, context dump, dossier

**Notice**:
The `display:false` board message a pi session receives at start and again
only when the board's shape changes, so keeping the board truthful is enforced
by context rather than prompt discipline.
_Avoid_: Ping, reminder, board feed, injection

**Repo skill**:
A procedural SKILL.md checked into this repo's `skills/<name>/` — one per recurring procedure — symlinked by `scripts/install.sh` into every agent surface's skill root (`~/.pi/agent/skills/`, `~/.agents/skills/`) so all agents read one live source.
_Avoid_: Project skill (collides with Project the card label), custom skill, personal skill.

**Overview**:
The cheap one-read board shape — lane counts, WIP limits, and owned cards,
never card bodies — the orientation companion to Brief.
_Avoid_: Dashboard, board summary, digest, glance

**Owner**:
The actor currently responsible for a card, recorded as a `tasks.owner` value
set when a card enters Test + Implement and cleared when it leaves, making
"who's on this" a fact rather than a thread-read.
_Avoid_: Assignee, claimant, holder, session binding

**Lead actor**:
The first actor of a lane's context (`actors[0]`) — the one a review `--block`
return hands ownership to on re-entering Test + Implement, and the fallback
owner when no context exists is none (`null`).
_Avoid_: Primary actor, default builder, first agent

**Anchor**:
The card a move is positioned relative to (`mv <id> <lane> --before <anchorId>`),
so placement survives concurrent edits instead of drifting like an index.
_Avoid_: Reference card, pivot, position marker

**Slot**:
The card-sized opening rendered at the drop hint while dragging — the dragged
card's own element shown at the target position while a lifted clone follows
the cursor. Replaces the old 2px drop-gap line.
_Avoid_: Drop gap, placeholder, spacer

**Settled layout**:
The transform-immune position of a card (its offsetTop/offsetHeight place in
the lane) while `animate:flip` runs; drag hints are decided against settled
layout so measurement never chases moving cards.
_Avoid_: resting position, final position

**Ghost**:
The inert DOM clone of the dragged card that follows the cursor during a
pointer drag, removed on settle or cancel; `pointer-events: none` keeps hit
testing honest.
_Avoid_: Drag image, browser ghost, floating card

**Gate**:
The human-only decision point (`approve` or `reject`) between plan review and implementation that agents are forbidden to run themselves.
_Avoid_: Checkpoint, sign-off, auto-approval

**Lane context**:
The optional workflow a lane hosts (`lanes.context`): an ordered **actor** chain with prompt instructions (`{id}` / `{title}` / `{tmpFile}` placeholders), an artifact template, and trigger/exit/gate/cap rules the generic loop interprets; plan → implement → review ships as the seeded default, and any custom lane gains its own workflow by setting one.
_Avoid_: Column config, lane settings, workflow DSL

**Actor**:
One agent on a lane's chain (`LaneActor`): a role id, a `pi-` thread author, prompt instructions, and optional agent config; a lane arms its actors per its context's rules.
_Avoid_: Role, agent slot, worker

**Git gate**:
The `pre-commit` + `pre-merge-commit` hooks (`scripts/hooks/`, wired via `core.hooksPath` by `install.sh`) that run `bun run check` + `bun test` before a commit or workspace merge lands. Docs-only commits skip it; `git commit --no-verify` is the WIP escape hatch (merges have none).
_Avoid_: Pre-commit hook, husky, lint gate

## Autoreview roles

**Planner** (`pi-planner`):
The agent role that drafts or revises a card's versioned plan in the `Plan` lane and challenges fuzzy terms against the glossary.
_Avoid_: Spec writer, architect

**Plan reviewer** (`pi-plan-reviewer`):
The agent role that critiques an attached plan against the review checklist before the card parks at the human gate.
_Avoid_: Spec reviewer, gatekeeper

**Builder** (`pi-builder`):
The agent role that executes an approved plan in `Test + Implement` or resolves review findings after a block.
_Avoid_: Implementer, coder, developer, worker

**Reviewer** (`pi-reviewer`):
The agent role that evaluates completed work in the `Review` lane against the plan and review rules, recording an approve or block verdict with proof.
_Avoid_: QA, verifier, auditor

**Board manager** (`pi-manager`):
The resident chat agent behind the web UI's board chat: one session with a board-wide view (lane counts, aging, what's parked, what's next) that proposes lane sweeps on request and relays their summaries.
_Avoid_: Orchestrator, supervisor, main agent

**Lane worker** (`pi-worker-<lane>`):
A short-lived headless agent with a charter over one lane (`kanban worker run <lane>`), drained by the serve process; Backlog's charter is the only writable one, the rest report. Distinct from the loop's spawn pools (`worker_pools`), which it does not use.
_Avoid_: Worker, agent pool, column agent
