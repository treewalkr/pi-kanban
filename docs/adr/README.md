# Architecture Decision Records

ADRs live in `docs/adr/` and use sequential four-digit numbering: `0001-slug.md`, `0002-slug.md`, and so on. Scan `docs/adr/` for the highest existing number and increment by one.

## When to write an ADR

Record an ADR only when **all three** hold:

1. **Hard to reverse** — changing our mind later carries meaningful cost across workflow, data model, or contracts.
2. **Surprising without context** — a future reader looking at the codebase would wonder why it was done this way.
3. **The result of a real trade-off** — genuine alternatives existed and we picked one for specific reasons.

If any of the three is missing, skip the ADR.

## Format

```md
# {Short title of the decision}

{1-3 sentences: what is the context, what did we decide, and why.}
```

Optional sections (`Status`, `Considered Options`, `Consequences`) may be included only when they add genuine value beyond the opening paragraph.
