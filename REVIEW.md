# REVIEW.md — living review rules for the auto-review agents

pi-reviewer and pi-builder read this file at the start of every session (see src/autoreview.ts).

## Rules

- Findings require proof: a failing repro (command + observed output) or the exact quoted code path. Unverified concerns are comments, not findings. (brs9w)
- Every finding is tagged [blocker] / [minor] / [nit]; block only on blockers. (xetf8)

## Lessons

Append one dated line whenever a human overrides a verdict, a finding turns out to be wrong, or review misses something that reaches Done.

<!-- format: - YYYY-MM-DD · lesson in one sentence -->
