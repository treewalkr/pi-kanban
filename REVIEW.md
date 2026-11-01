# REVIEW.md — living review rules for the auto-review agents

pi-reviewer and pi-builder read this file at the start of every session (see src/autoreview.ts).

## Rules

- Findings require proof: a failing repro (command + observed output) or the exact quoted code path. Unverified concerns are comments, not findings. (brs9w)
- Every finding is tagged [blocker] / [minor] / [nit]; block only on blockers. (xetf8)

## Lessons

Append one dated line whenever a human overrides a verdict, a finding turns out to be wrong, or review misses something that reaches Done.

<!-- format: - YYYY-MM-DD · lesson in one sentence -->

- 2026-10-29 · Code blocks scroll, never wrap — review approved pre-wrap (1740c72) and the user reversed it the same day (9b21ba2).
- 2026-10-30 · On/off states must differ by more than hue — stack filled icon + tinted pill + accent (a59042a).
- 2026-11-01 · Multi-value chips like tags belong in a popover, never inline in header rows (a3deeea).
