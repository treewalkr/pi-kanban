#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "workspace: usage: scripts/workspace.sh <new|done> <slug>" >&2
  exit 1
fi

CMD="$1"
SLUG="$2"

if [ "$CMD" != "new" ] && [ "$CMD" != "done" ]; then
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

if [ "$CMD" = "done" ]; then
  if [ ! -d "$WT" ]; then
    echo "workspace: no workspace at $WT — try git worktree list" >&2
    exit 1
  fi

  if [ -n "$(git -C "$WT" status --porcelain)" ]; then
    echo "workspace: $WT has uncommitted changes — commit or stash inside it first" >&2
    exit 1
  fi

  if [ -n "$(git -C "$MAIN" status --porcelain)" ]; then
    echo "workspace: main tree is dirty — commit or stash in $MAIN before merging" >&2
    exit 1
  fi

  if ! git -C "$MAIN" merge --no-ff "$SLUG" -m "merge: $SLUG"; then
    echo "workspace: merge failed — resolve conflicts and commit the merge in $MAIN, then rerun scripts/workspace.sh done $SLUG" >&2
    exit 1
  fi

  git -C "$MAIN" worktree remove "$WT"
  git -C "$MAIN" branch -d "$SLUG"

  if [ -n "$(git -C "$MAIN" status --porcelain)" ]; then
    echo "workspace: main tree is not clean after merge — inspect git status" >&2
    exit 1
  fi

  echo "workspace: $SLUG merged and removed — main tree clean"
  exit 0
fi
