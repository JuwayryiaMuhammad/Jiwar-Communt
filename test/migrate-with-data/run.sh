#!/usr/bin/env bash
# migrate-with-data (ADR 0061): the previous main's migrations, a seed, then
# the branch's migrations over it, as the migrator staging uses, and checks.
#
#   test/migrate-with-data/run.sh <base-commit>
#
# Needs MIGRATOR_DATABASE_URL (jiwar_migrator: owner, not a superuser, no
# BYPASSRLS, from docker/postgres/init.sql) and SUPERUSER_DATABASE_URL (the
# seed and the reads), both on the same EMPTY database. Run from the repo
# root after `pnpm install`. CI runs it in the migrate-with-data job.
set -euo pipefail
BASE=${1:?usage: run.sh <base-commit>}
: "${MIGRATOR_DATABASE_URL:?}" "${SUPERUSER_DATABASE_URL:?}"
ROOT=$(pwd)
CLI="node_modules/.bin/ts-node --transpile-only src/core/database/migrate-with-data.cli.ts"
db_of() { sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#' <<<"$1"; }
[ "$(db_of "$MIGRATOR_DATABASE_URL")" = "$(db_of "$SUPERUSER_DATABASE_URL")" ] ||
  { echo "the two URLs name different databases" >&2; exit 2; }
echo "== base $(git rev-parse --short "$BASE"), head $(git rev-parse --short HEAD), database $(db_of "$MIGRATOR_DATABASE_URL")"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# Its last lines on success, all of it on failure.
quiet() { if ! "$@" >"$WORK/out.log" 2>&1; then cat "$WORK/out.log"; return 1; fi; tail -2 "$WORK/out.log"; }

# 1. The base's own migrations, schema and config, applied as the migrator.
mkdir -p "$WORK/base"
git archive "$BASE" prisma prisma.config.ts | tar -x -C "$WORK/base"
ln -s "$ROOT/node_modules" "$WORK/base/node_modules"
echo "== 1. base: $(ls -d "$WORK"/base/prisma/migrations/*/ | wc -l) migrations"
(cd "$WORK/base" && quiet "$ROOT/node_modules/.bin/prisma" migrate deploy)

# 2. The seed as the base had it (the branch's when the base has none yet).
if git show "$BASE:test/migrate-with-data/seed.sql" >"$WORK/seed-base.sql" 2>/dev/null; then
  echo "== 2. seed from the base"
else
  cp test/migrate-with-data/seed.sql "$WORK/seed-base.sql"
  echo "== 2. seed from the branch (the base has none yet)"
fi
$CLI exec "$WORK/seed-base.sql"
$CLI snapshot "$WORK/before.json"

# 3. The branch's migrations, as the migrator: any error fails here.
echo "== 3. branch: $(ls -d prisma/migrations/*/ | wc -l) migrations"
quiet node_modules/.bin/prisma migrate deploy

# 4. What the database must hold now.
echo "== 4. assert"
$CLI assert "$WORK/before.json"

# 5. The branch's seed still loads on the new schema.
echo "== 5. the branch's seed on the new schema"
$CLI exec test/migrate-with-data/seed.sql
echo "== migrate-with-data: passed"
