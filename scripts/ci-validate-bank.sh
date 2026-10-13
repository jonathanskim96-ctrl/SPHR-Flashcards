#!/usr/bin/env bash
# CI: validate content/questions.json against the copy on the base commit, so a question id
# can never silently disappear (BUILD_PLAN Phase 0). BASE_SHA comes from the workflow via env.
# If there is no usable base (first push of a new branch), fall back to the merge-base with
# origin/main; if the bank did not exist there, validate without --previous.
set -euo pipefail

base="${BASE_SHA:-}"
if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ] \
  || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  base="$(git merge-base HEAD origin/main 2>/dev/null || true)"
fi

prev="${RUNNER_TEMP:-/tmp}/prev-questions.json"
if [ -n "$base" ] && git cat-file -e "${base}:content/questions.json" 2>/dev/null; then
  git show "${base}:content/questions.json" > "$prev"
  echo "Comparing with content/questions.json at ${base}"
  node scripts/validate-bank.mjs content/questions.json --previous "$prev"
else
  echo "No previous bank on the base commit; validating without --previous"
  node scripts/validate-bank.mjs content/questions.json
fi
