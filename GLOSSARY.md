# Kanban

A shared task board where humans and autonomous agents coordinate work from initial capture through planning, implementation, and review. The board serves as durable external memory so stateless agent sessions stay aligned with human intent.

## Language

**Card**:
A single unit of work on the board, carrying a title, note, attached files, and thread as it moves across lanes.
_Avoid_: Task, ticket, issue, item

**Lane**:
A named workflow stage on the board (`Waiting on you`, `Backlog`, `Plan`, `Test + Implement`, `Review`, `Done`, `Archive`) that holds an ordered list of cards.
_Avoid_: Column, state, status, stage

**Project**:
A label associating a card with a codebase or workstream so one shared board can filter work across multiple efforts.
_Avoid_: Board, namespace, repo tag

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

**Gate**:
The human-only decision point (`approve` or `reject`) between plan review and implementation that agents are forbidden to run themselves.
_Avoid_: Checkpoint, sign-off, auto-approval

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
