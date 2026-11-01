#!/usr/bin/env bash
# Installs the kanban CLI + pi skill from this repo.
set -euo pipefail
cd "$(dirname "$0")/.."

# Refuse to install from a git worktree: the bin symlink would point at the
# worktree's code (and its own data/kanban.db), so `kanban serve` would come
# up on a split-brain board (the 10/31 incident).
if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
  echo "refusing: $(pwd) is a git worktree — run install.sh from the main checkout" >&2
  exit 1
fi

BIN_DIR="${HOME}/.bun/bin"
mkdir -p "$BIN_DIR"
chmod +x src/cli.ts
ln -sf "$(pwd)/src/cli.ts" "$BIN_DIR/kanban"

SKILL_DIR="${HOME}/.pi/agent/skills/pi-kanban"
mkdir -p "$SKILL_DIR"
cp skills/pi-kanban/SKILL.md "$SKILL_DIR/SKILL.md"
cp skills/pi-kanban/plan-template.md "$SKILL_DIR/plan-template.md"

# Git gate: check + test must pass on commits and merges.
chmod +x scripts/hooks/pre-commit scripts/hooks/pre-merge-commit scripts/hooks/gate.sh
git config core.hooksPath scripts/hooks

echo "installed:"
echo "  cli    → $BIN_DIR/kanban"
echo "  skill  → $SKILL_DIR/SKILL.md"
echo "  hooks  → core.hooksPath scripts/hooks (pre-commit + pre-merge-commit: check + test)"
echo "web ui  → kanban serve --open   (or: bun run dev)"
