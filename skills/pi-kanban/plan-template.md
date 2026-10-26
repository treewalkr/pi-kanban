# Plan template

Every Plan-lane plan uses this template: the planner writes it, the plan
reviewer checks it against the checklist below, and the builder follows it as
its contract. Fill every section, or write `N/A — reason` (one line on why it
does not apply). Ground every claim in the repo: cite AGENTS.md and real file
paths; never invent APIs.

## Plan template

### Goal
One or two sentences: what changes for the user or agent, and why. Copy the
card's acceptance criteria here as a numbered list (AC1, AC2, …) — the test
plan maps to these numbers.

### Context & constraints
What the repo already does that this work builds on, with citations
(`path:line`, AGENTS.md rules, existing patterns to follow).

### Decisions
One entry per real choice: **choice** / alternatives considered / why this one.
Fix anything two builders could reasonably do differently.

### Interfaces & contracts
Fixed exactly — the builder must not deviate: file paths, exported names and
signatures, DB schema, routes and request/response shapes, CLI flags, error
messages, comment kinds and authors. Internals stay open.

### Steps
Numbered, each with its target files and the commit it ends in. Small, ordered,
each leaving the suite green.

### Test plan
A table mapping every acceptance criterion to at least one test:

| AC | Type (unit / integration / e2e) | File | Test name | Asserts | Command |
|----|------|------|-----------|---------|---------|

Then the full-suite command(s) that must be green before handoff.

### Architecture impact
Modules touched, new seams or dependencies between them, layering rules kept.

### Stack & dependencies
New or changed packages, tools, versions — or why none are needed.

### Data & migrations
Schema or stored-data changes, migration path, effect on existing rows.

### Security
Input validation, auth, secrets, exposure (e.g. localhost-only binding).

### Performance
Hot paths, query counts, payload sizes, cost of agent sessions.

### Backward compatibility
Existing CLI flags, API shapes, stored data and workflows that must keep working.

### Observability
Logs, comments, or UI signals that show the change working or failing.

### Rollback
How to undo: which commits revert cleanly, any data cleanup.

### Out of scope
What this plan deliberately does not do (follow-up cards).

### Risks
What could go wrong, with likelihood and mitigation.

### Open questions
Unresolved questions, each with the recommended default the builder will use
if nobody answers. Empty means none.

## Review checklist

Block the plan if any of these hold:

- A template section is missing, empty, or `N/A` without a reason.
- An acceptance criterion has no test in the test plan.
- A test entry is vague ("add tests for X") instead of naming file, test, assertion, and command.
- An interface or contract is left loose where two builders would diverge (path, signature, schema, route, flag, error message).
- A cited path, function, or API does not exist in the repo, or the plan contradicts AGENTS.md.
- A step has no target file, or steps are out of order (a step depends on a later one).
- A decision lists no rejected alternative.
- The plan ignores feedback from an earlier rejection or plan-review block in the thread.
