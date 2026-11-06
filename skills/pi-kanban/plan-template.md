# Plan template

Every Plan-lane plan uses this template: the planner writes it, the plan
reviewer checks it against the checklist below, and the builder follows it as
its contract. Fill every section, or write `N/A — reason` (one line on why it
does not apply). Ground every claim in the repo: cite AGENTS.md and real file
paths; never invent APIs.

**Write a lean plan for a literal executor.** The builder may be a smaller,
faster model than the planner. It follows the steps in order and makes no design
choices: every judgment call is made here, as an exact contract or a precise
behavior. The plan does not contain the implementation — the builder writes
function and test bodies from the plan's contracts and test specs, and fixes
until each step's Check passes. If a builder would have to decide something,
the plan is not finished; if the plan pastes code the builder could write from a
contract, it is too heavy. Aim for 150–300 lines — a card that needs more is a
card to split.

## Plan template

### Goal
One or two sentences: what changes for the user or agent, and why. Copy the
card's acceptance criteria here as a numbered list (AC1, AC2, …) — the test
plan maps to these numbers.

### Context & constraints
What the repo already does that this work builds on, with citations
(`path:line` plus the enclosing function or symbol name — line numbers drift,
names anchor; AGENTS.md rules; existing patterns to follow). Always include:

- **Verified at** — the commit you read (`git rev-parse --short HEAD` on the
  default branch). Ground only in code on that branch, never in unmerged work.
- **Baseline** — the full-suite command(s) the builder runs in Step 0. Do not
  run the suite yourself unless the card is about failing tests.
- **Guard tests** — the existing tests that pin each file or symbol the plan
  changes (search the test directories for the path and symbol names), and for
  each one: stays green as-is, or is updated in step N.
- **Redundancy check** — where you searched for an existing implementation.

### Decisions
One entry per real choice: **choice** / alternatives considered / why this one.
Fix anything two builders could reasonably do differently.

### Interfaces & contracts
Fixed exactly — the builder must not deviate: file paths, exported names and
signatures, DB schema, routes and request/response shapes, CLI flags, error
messages, comment kinds and authors. Internals stay open. A new file's path must
not collide with an existing path when compared case-insensitively (macOS).

### Steps
Ordered steps, each leaving the suite green. Step 0 is the baseline: the
workspace or branch to create, any environment prerequisite, and the full suite
green before anything is touched. The last step runs the full suite and hands
off. Every step between has exactly these four parts:

- **Files** — every path the step creates, edits, or deletes. Nothing else is
  touched or staged.
- **Do** — the exact change, anchored by path and symbol name. Give
  paste-ready text only for contracts two builders could write differently:
  new exported types and signatures, schema/SQL and migrations, route
  request/response shapes, CLI flags, prompt and message text, exact error
  strings. Describe each function body as behavior — inputs → outputs, branches,
  error cases — for the builder to write. An edit to existing code quotes the
  code it replaces or names the symbol and the change. Prose alone is fine for a
  mechanical change two builders cannot do differently (a rename, an import).
- **Check** — the command(s) to run and the expected observable result
  (e.g. `bun test test/x.test.ts` → `0 fail`, or an exact output line), plus
  which guard tests this step touches and why they stay green.
- **Commit** — the exact one-line commit message, or `none`.

Never write "as needed", "etc.", "similar to", "handle edge cases", "update
accordingly", "if necessary", "appropriate", or "TBD" in a step: each is a
decision left to the builder. If a step depends on state that only exists after
an earlier step (a generated file, a migration), say what that state looks like.
If the plan needs more than about 12 steps, or two parts could ship
independently, ask before planning whether to split the card (recommended
default: your proposed split).

### Test plan
A table mapping every acceptance criterion to at least one test. Every entry
names its seam: the public interface the test lives at (CLI command or flag
with its observable output, HTTP route with its response shape, exported
function or module API, or a db.ts query function) plus a short why — prefer
the highest seam that can observe the behavior, and never name an internal
helper. `N/A — reason` is allowed only when no public seam observes it:

| AC | Type (unit / integration / e2e) | Seam (public interface — why) | File | Test name | Asserts | Command |
|----|------|------|------|-----------|---------|---------|

Every test is specified, not written: its file, name, setup or inputs, and the
exact assertions (values, status codes, error strings) — the builder writes the
body in the step that lists it. New tests own their data: unique
ids and names, their own temp DB or fixtures, never state another test or spec
asserts on (specs may run in parallel). When the change reshapes rendered UI,
list the existing e2e specs that cover that UI and run them too.

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
- A test entry names no seam, a vague seam ("unit tests" with no interface), or an internal helper instead of a public interface — or its seam is `N/A` without a reason.
- An interface or contract is left loose where two builders would diverge (path, signature, schema, route, flag, error message).
- A cited path, function, or API does not exist in the repo, or the plan contradicts AGENTS.md.
- A step has no target file, or steps are out of order (a step depends on a later one).
- A decision lists no rejected alternative.
- The plan ignores feedback from an earlier rejection or plan-review block in the thread.
- Context & constraints lacks the verified-at commit, the baseline command, or the guard tests for a changed file.
- Steps do not start with a Step 0 baseline, or do not end with the full suite and handoff.
- A step lacks Files, Do, Check, or Commit; or its Check has no command or no expected result.
- A step leaves a design decision to the builder: a contract (exported signature, schema, route shape, flag, prompt or error text) not given exactly, a function body described without its inputs, outputs, and error cases, a banned phrase ("as needed", "etc.", "similar to", "handle edge cases", "update accordingly", "if necessary", "appropriate", "TBD"), or an edit with no anchor (path plus symbol or quoted code).
- A planned test lacks its file, name, inputs, or exact assertions, or a test writes to data another test or spec asserts on.
- The plan is heavy: it pastes finished implementation or test bodies where a contract or behavior description would do, or runs well past ~300 lines without proposing a split.
- A guard test the change would break is not updated in a step.
- A new file path collides case-insensitively with an existing path.
