---
name: resume-build
description: Use when picking up a card whose builder session died mid-build (kanban ps shows an abandoned lease, or the thread says a session died). Locate the dead session, check the workspace tree for unsaved work, then resume manually — this repo (kanban) only.
---
# resume-build — picking up a dead build

Dead builds **resume manually, never respawn**. A fresh session re-does work
from zero and loses the transcript — the loop's own wording, printed by
`kanban ps` (`src/cli.ts`).

## 1. Locate the dead session

- `kanban ps` (or `kanban ps --json`) lists abandoned leases: card id, role,
  heartbeat age, and the dead owner pid.
- Session ids are shaped `kanban-<cardId>-<role>-<base36 time>`
  (`sessionIdFor`, `src/autoreview.ts`).
- The card thread's death comment (`session died: …`, `SESSION_DIED_PREFIX` in
  `src/db.ts`) names the role that died and the reason.

## 2. Check the tree first

In the card's workspace (`git worktree list`; the card's `ws` field names the
slug), run before acting:

```bash
git status
git stash list
git log --oneline -5
```

A dead session can leave a dirty tree or a stash behind, and a second session
stashing over it loses work (the e028f3e race). Restore or commit whatever the
dead session left before resuming.

## 3. Resume

- **Loop cards**: the web card detail's "↻ resume session" button, or
  `POST /tasks/:id/resume` — the loop resumes the same session id and role.
  It 409s unless the card is waiting on a dead session; a lease still in
  flight also blocks.
- **Interactive pickup**: `pi --session-id <id>` inside the workspace
  continues the transcript.

## 4. No session recorded?

If the card has no session at all, don't fake one — add any comment to the
card to re-trigger the loop instead.
