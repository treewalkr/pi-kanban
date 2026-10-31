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

# Check first: type errors fail fast in ~7s before the ~51s suite.
echo "$name: running check (svelte-check + tsc)"
if ! bun run check; then
  echo "$hint" >&2
  exit 1
fi

echo "$name: running bun test"
if ! bun test; then
  echo "$hint" >&2
  exit 1
fi
