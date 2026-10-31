# Agents never run the gate

In the autonomous board loop (`pi-planner` → `pi-plan-reviewer` → gate → `pi-builder` → `pi-reviewer`), agents draft plans, critique plans, write code, and approve code to `Done`, yet passing plan review parks the card in `Waiting on you` instead of advancing to `Test + Implement`. We decided that only a human may run the plan gate (`approve` or `reject`), and agent-authored approvals never arm the builder. Misaligned intent is the highest-cost failure mode in autonomous coding: catching a wrong assumption while the artifact is still a markdown plan costs seconds of human reading, whereas letting an agent self-approve burns full build and review cycles on the wrong work.

## Considered Options

- **Human-only plan gate (`approve` / `reject`)**: `pi-plan-reviewer --pass` parks the card in `Waiting on you`; only a non-`pi-*` human approval moves the card to `Test + Implement` and arms `pi-builder`.
- **End-to-end autonomous flow (`pi-plan-reviewer --pass` arms `pi-builder` directly)**: zero human wait between planning and coding, but compounding misalignment goes unchecked until code review or after `Done`.
