#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "workspace: usage: scripts/workspace.sh <new|done> <slug>" >&2
  exit 1
fi

CMD="$1"
SLUG="$2"

if [ "$CMD" != "new" ]; then
  echo "workspace: usage: scripts/workspace.sh <new|done> <slug>" >&2
  exit 1
fi

if ! [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; then
  echo "workspace: slug must be 1-40 chars of lowercase alphanumerics and dashes — got '$SLUG'" >&2
  exit 1
fi

MAIN="$(git worktree list --porcelain | sed -n '/^worktree /{s/^worktree //;p;q;}')"
WT="$(dirname "$MAIN")/$(basename "$MAIN")-$SLUG"

if [ "$CMD" = "new" ]; then
  if [ -e "$WT" ]; then
    echo "workspace: $WT already exists — pick another slug" >&2
    exit 1
  fi

  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$SLUG"; then
    echo "workspace: branch $SLUG already exists — pick another slug" >&2
    exit 1
  fi

  git -C "$MAIN" worktree add -b "$SLUG" "$WT"
  echo "workspace: created $WT on branch $SLUG"
  exit 0
fi
