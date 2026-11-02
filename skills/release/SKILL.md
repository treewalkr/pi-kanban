---
name: release
description: Use when cutting a release of pi-kanban (version bump, wiring checks, tag, GitHub release). Two-file version bump, gate green, install + skills.sh still wired, tag and push, gh release create — this repo (kanban) only.
---
# release — cutting a pi-kanban release

## 1. Bump both version sources together

`src/version.ts` `VERSION` is the single source for the CLI banner,
`kanban version`, and `/health` — and `package.json` `version` must match.
Bump both in one commit:

```bash
git commit -m "chore: bump version to X.Y.Z" src/version.ts package.json
```

Precedent: 449a92f ("chore: bump version to 0.8.0") touched exactly these two
files. Tags `v0.7.0` and `v0.8.0` exist and are pushed; no GitHub releases
have been cut yet.

## 2. Pre-tag checks

From the main checkout (never a worktree):

- `bun run check && bun test` — the git-gate pair, green.
- `./scripts/install.sh` — re-wires the CLI symlink, skills, and hooks on this
  machine; must run clean.
- `kanban version` prints the new version.
- `npx skills add treewalkr/pi-kanban` still installs — skills.sh indexes this
  repo, and the frontmatter contract of every `skills/*/SKILL.md` is what it
  consumes.

## 3. Tag, push, release

```bash
git tag vX.Y.Z
git push origin main --tags
gh release create vX.Y.Z
```

## 4. After: the serve lags

A running serve keeps reporting the old version until restarted — the web
header's `⟳ stale` chip flags it. Restart the service (settings → restart, or
`kanban stop && kanban serve`), then verify `/health` shows the new version.
