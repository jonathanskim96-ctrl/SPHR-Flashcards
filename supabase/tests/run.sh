#!/usr/bin/env bash
# Local database tests (no cloud needed). Starts a throwaway PostgreSQL in a temp dir,
# creates a small stand-in for Supabase's auth schema and roles (auth_shim.sql), applies
# supabase/migrations/*.sql in order, then runs supabase/tests/*.test.sql in order.
# Any failed statement or assert stops the run with a non-zero exit code.
#
# Uses a locally installed PostgreSQL (initdb). Set PG_BIN to pick a specific bin dir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_BIN="${PG_BIN:-$( (pg_config --bindir 2>/dev/null) || true)}"
if [ -z "$PG_BIN" ] || [ ! -x "$PG_BIN/initdb" ]; then
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$PG_BIN" ] || [ ! -x "$PG_BIN/initdb" ]; then
  echo "run.sh: PostgreSQL (initdb) not found. Install PostgreSQL or set PG_BIN." >&2
  exit 1
fi

WORK="$(mktemp -d)"
PORT="${PG_TEST_PORT:-54329}"
# initdb refuses to run as root; in that case run the server as the 'postgres' OS user.
AS=()
if [ "$(id -u)" = "0" ]; then
  AS=(runuser -u postgres --)
  chown postgres "$WORK"
fi

cleanup() {
  "${AS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

"${AS[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres --auth=trust -E UTF8 --locale=C >"$WORK/initdb.log" 2>&1 \
  || { cat "$WORK/initdb.log" >&2; exit 1; }
"${AS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/server.log" -w \
  -o "-k $WORK -p $PORT -c listen_addresses='' -c fsync=off" start >/dev/null \
  || { cat "$WORK/server.log" >&2; exit 1; }

PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -d app)
"${PSQL[@]}" -U postgres -d postgres -c "create database app" >/dev/null
# Test files and *.test.sh scripts use these to reach the database.
export ROOT PG_BIN PGHOST="$WORK" PGPORT="$PORT" PGDATABASE=app
run_file() { # file [user]
  echo "  $1"
  "${PSQL[@]}" -U "${2:-postgres}" -f "$1"
}

echo "Auth shim:"
run_file "$ROOT/supabase/tests/auth_shim.sql"

echo "Migrations:"
shopt -s nullglob
migrations=("$ROOT"/supabase/migrations/*.sql)
[ ${#migrations[@]} -eq 0 ] && echo "  (none yet)"
# Applied as `migrator`, a non-superuser like Supabase's `postgres` role.
for f in "${migrations[@]}"; do run_file "$f" migrator; done

echo "Tests:"
tests=("$ROOT"/supabase/tests/*.test.sql "$ROOT"/supabase/tests/*.test.sh)
if [ ${#tests[@]} -eq 0 ]; then echo "run.sh: no test files found" >&2; exit 1; fi
IFS=$'\n' tests=($(printf '%s\n' "${tests[@]}" | sort)); unset IFS
for f in "${tests[@]}"; do
  case "$f" in
    *.sh) echo "  $f"; bash "$f" ;;
    *) run_file "$f" ;;
  esac
done

echo "OK: database tests passed (${#migrations[@]} migration(s), ${#tests[@]} test file(s))."
