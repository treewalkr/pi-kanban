#!/usr/bin/env bash
# Shared gate for the pre-commit / pre-merge-commit hooks: check + test must pass.
# Usage: bash gate.sh <pre-commit|pre-merge-commit>
set -euo pipefail

case "${1:-}" in
  pre-commit)
    hint="pre-commit: blocked — fix above, or bypass with: git commit --no-verify"
    ;;
  pre-merge-commit)
    hint="pre-merge-commit: blocked — fix above, then git commit to conclude (bypass: git commit --no-verify)"
    ;;
  *)
    echo "gate: usage: gate.sh <pre-commit|pre-merge-commit>" >&2
    exit 2
    ;;
esac
name="$1"

# Git runs hooks with GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE set to this repo —
# but the check/test runs (and the git calls test suites make in sandboxed
# temp repos) must resolve the repo from their own cwd. Strip them.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX

# Check first: type errors fail fast in ~7s before the suite.
echo "$name: running check (svelte-check + tsc)"
if ! bun run check; then
  echo "$hint" >&2
  exit 1
fi

echo "$name: running bun test --parallel"
if ! bun test --parallel; then
  echo "$hint" >&2
  exit 1
fi
