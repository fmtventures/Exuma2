#!/usr/bin/env bash
#
# Applies the schema and RLS policies to a scratch database and runs the
# tenancy assertions against it.
#
#   ./scripts/db-test.sh              # uses a local cluster it starts itself
#   PGHOST=... PGPORT=... ./scripts/db-test.sh   # uses an existing server (CI)
#
# Exits non-zero if any assertion fails. Skips with a clear message — not a
# silent pass — when no Postgres is available.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${SIDELIO_TEST_DB:-sidelio_dbtest}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
OWN_CLUSTER=""

if [ -z "${PGHOST:-}" ]; then
  if [ ! -x "$PGBIN/initdb" ]; then
    echo "SKIP: no Postgres server found (set PGHOST to use an existing one)" >&2
    exit 0
  fi

  # Postgres refuses to run as root, so use an unprivileged account.
  RUNAS="${SIDELIO_PG_USER:-postgres}"
  id "$RUNAS" >/dev/null 2>&1 || RUNAS="$(id -un)"

  export PGDATA="${PGDATA:-/tmp/sidelio-pgdata}"
  export PGHOST=/tmp/sidelio-pgrun
  export PGPORT="${PGPORT:-5433}"
  export PGUSER=postgres
  OWN_CLUSTER=1

  rm -rf "$PGDATA" "$PGHOST"
  mkdir -p "$PGDATA" "$PGHOST"
  if [ "$(id -u)" = "0" ]; then chown -R "$RUNAS" "$PGDATA" "$PGHOST"; fi

  run() { if [ "$(id -u)" = "0" ]; then su "$RUNAS" -s /bin/bash -c "$1"; else bash -c "$1"; fi; }
  run "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
  run "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -k $PGHOST -c listen_addresses=' -l /tmp/sidelio-pg.log start" >/dev/null

  cleanup() {
    [ -n "$OWN_CLUSTER" ] || return 0
    run "$PGBIN/pg_ctl -D $PGDATA -m immediate stop" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  for _ in $(seq 1 30); do
    "$PGBIN/pg_isready" -q && break
    sleep 0.3
  done
fi

command -v psql >/dev/null || { echo "SKIP: psql not on PATH" >&2; exit 0; }
export PATH="$PGBIN:$PATH"

echo "→ recreating $DB"
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB;" >/dev/null
psql -q -d postgres -c "CREATE DATABASE $DB;" >/dev/null

echo "→ applying schema.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/src/db/schema.sql" >/dev/null

echo "→ applying rls.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/src/db/rls.sql" >/dev/null

# Re-running must be safe: roles are cluster-wide, so a second apply used to
# abort at CREATE ROLE and leave the database without policies or grants.
echo "→ re-applying rls.sql (idempotency)"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/src/db/rls.sql" >/dev/null

echo "→ running tenancy assertions"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/tests/db/tenancy.sql"

echo "✓ schema, RLS and tenancy isolation verified"
