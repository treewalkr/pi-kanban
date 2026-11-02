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

# Repo skills: every skills/<name> dir is symlinked (not copied) into both agent
# skill roots — pi (~/.pi/agent/skills) and the shared ~/.agents/skills — so every
# surface reads one live source (same pattern as the notice extension below).
for skill_dir in skills/*/; do
  name="$(basename "$skill_dir")"
  for root in "${HOME}/.pi/agent/skills" "${HOME}/.agents/skills"; do
    mkdir -p "$root"
    dest="$root/$name"
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
      echo "replacing $dest (existing non-symlink) with repo symlink" >&2
      rm -rf "$dest"
    fi
    ln -sfn "$(pwd)/skills/$name" "$dest"
  done
done

# Board notice: pi loads extensions from ~/.pi/agent/extensions; the notice is a
# Node-safe module that reads the board through the CLI installed above.
EXT_DIR="${HOME}/.pi/agent/extensions"
mkdir -p "$EXT_DIR"
ln -sf "$(pwd)/src/notice.ts" "$EXT_DIR/kanban-notice.ts"

# Git gate: check + test must pass on commits and merges.
chmod +x scripts/hooks/pre-commit scripts/hooks/pre-merge-commit scripts/hooks/gate.sh
git config core.hooksPath scripts/hooks

echo "installed:"
echo "  cli    → $BIN_DIR/kanban"
echo "  skills → every skills/<name> symlinked into ~/.pi/agent/skills and ~/.agents/skills"
echo "  notice → $EXT_DIR/kanban-notice.ts"
echo "  hooks  → core.hooksPath scripts/hooks (pre-commit + pre-merge-commit: check + test)"
echo "web ui  → kanban serve --open   (or: bun run dev)"
