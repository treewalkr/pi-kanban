#!/usr/bin/env bash
# Installs the kanban CLI + pi skill from this repo.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN_DIR="${HOME}/.bun/bin"
mkdir -p "$BIN_DIR"
chmod +x src/cli.ts
ln -sf "$(pwd)/src/cli.ts" "$BIN_DIR/kanban"

SKILL_DIR="${HOME}/.pi/agent/skills/pi-kanban"
mkdir -p "$SKILL_DIR"
cp skills/pi-kanban/SKILL.md "$SKILL_DIR/SKILL.md"
cp skills/pi-kanban/plan-template.md "$SKILL_DIR/plan-template.md"

echo "installed:"
echo "  cli    → $BIN_DIR/kanban"
echo "  skill  → $SKILL_DIR/SKILL.md"
echo "web ui  → kanban serve --open   (or: bun run dev)"
