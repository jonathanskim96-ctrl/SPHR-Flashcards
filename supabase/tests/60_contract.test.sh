#!/usr/bin/env bash
# App↔DB contract tests: the app's own code (validator, payload builder, reply readers)
# against the real functions in this throwaway database. Started by run.sh, which exports
# ROOT, PG_BIN, PGHOST, PGPORT and PGDATABASE.
set -euo pipefail
cd "$ROOT"
npx vitest run --config vitest.contract.config.ts --reporter=dot
