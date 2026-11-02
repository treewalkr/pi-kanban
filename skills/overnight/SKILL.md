---
name: overnight
description: Use when the user asks for work to continue overnight or while they are away. Arms an exit-wakeup watcher that starts the kanban agent loop after the session exits, with gate delegation only when the user hands it over — this repo (kanban) only.
---
# overnight — unattended work while the user is away

## The unattended path is the loop

`kanban serve --agents` runs the agent loop: planner, reviewer, and builder
sessions dispatched to cards as they become eligible (`src/autoreview.ts`,
`KANBAN_AUTO_REVIEW=1`). It backgrounds itself; `kanban ps` and `kanban stop`
manage it. Well-scoped cards staged before leaving are what it drains.

PENDING on branch `autopilot-runner` (unmerged at the time of writing — known
incident): queue-lane staging, `--project auto-pilot` opt-in, nightly budget,
ephemeral-worktree builds, and draft-PR handoff (card e52ke). Until that lands
on main, none of those commands or behaviors exist — do not use them.

## Arm the exit-wakeup watcher

Arm it in the interactive session (never inside the serve): a background
watcher sleeps until the session exits, then starts the overnight serve.

```bash
echo "$(date +%s) kanban serve --agents" > data/overnight.state
( while kill -0 $$ 2>/dev/null; do sleep 60; done
  nohup kanban serve --agents >> /tmp/kanban-overnight.log 2>&1 & ) &
```

- The state file `data/overnight.state` (gitignored, repo-local) records that
  overnight is armed and what was armed — any later session can see it.
- Disarm: delete the state file and `kanban stop`.

## Gate delegation only when the user hands it over

Auto-approval of gates is a human decision. Agents never run
`kanban approve`/`reject` — that law does not lapse overnight (AGENTS.md,
glossary **Gate**). Cards that hit a gate with no delegation park in
**Waiting on you** until morning; the user only gets unattended
gate-crossing where they have explicitly handed it over.

## Morning after

- `kanban ps` — what ran, and any abandoned leases (resume per the
  `resume-build` skill, never respawn).
- `kanban overview` — board shape after the night.
- The PR list (`gh pr list`) for anything the loop pushed.
