# 0061 — Migration safety in CI: a migration's DML on a FORCE RLS table must set the compound, and the branch's migrations are applied over a seeded database as the migrator staging uses

**Status:** Accepted · CI · amends ADR 0026 (CI) and ADR 0005 (database roles)

## Context

`prisma migrate deploy` runs as `jiwar_migrator`: the tables' owner, created by `docker/postgres/init.sql` as `NOSUPERUSER NOBYPASSRLS`, the same on staging (`deploy/compose.yml` mounts that file). Almost every tenant table has `FORCE ROW LEVEL SECURITY`, so its policies hold for the owner too. A migration's statement on such a table sees no compound unless it sets `app.tenant_id` first:
- an UPDATE or DELETE matches **no row, silently**;
- an INSERT is **refused**.

Two migrations reached main that way:
- **R11b-1's `20261108090000_account_logins`** backfilled a column, then made it NOT NULL. On a database with devices, the backfill matched nothing and the NOT NULL failed. It was fixed before merge, after a copy of the dev database failed.
- **G7's `20261104091000_instruction_validity`** backfilled `notified_at` and nothing more. It applied everywhere, set nothing, and old instructions would have been pushed again. It was fixed forward by `20261113090000`.

CI could see neither. The e2e global setup empties every table before it migrates, so every migration runs over no rows. And the database is migrated as the right role, but there is nothing in it for a missed backfill to miss.

## Decisions

### A static check: `pnpm migrations:check`

`src/core/database/migrations-rls-check.ts`, run in the `static` job and by its unit spec.

- **It reads every migration in name order** and learns from them which tables are forced, and from which point:
  - `ALTER TABLE … FORCE ROW LEVEL SECURITY` and `NO FORCE`;
  - the `FOREACH t IN ARRAY ARRAY[…] … EXECUTE format('ALTER TABLE %I FORCE …')` loop.
- **It fails** on an UPDATE, INSERT or DELETE on a forced table unless the statement sits in a `DO` block's loop that calls `set_config('app.tenant_id', <not ''>, …)` before it. The pattern is main's fixed `20261108090000`.
- **It ignores:** comments, string literals, and function bodies. A trigger runs later, as the app, with its compound set.
- **A true exception in a new migration** is marked on the line above the statement: `-- rls-dml-allow: <reason>`. A marker without a reason fails.
- **Applied migrations are never edited**, not even by a comment: their stored checksum would change on every database. Their exceptions live in `prisma/migrations-rls-allow.json` under `bareDml`, as `"<migration>:<line>": "<reason>"`. An entry that no longer matches a statement fails, and so does one with no reason or an unknown migration.
- **The two historic statements are listed there:**
  - `20261021090100_visitor_pass_group_entries`: applied everywhere before there was a row to miss;
  - `20261104091000_instruction_validity`: fixed forward by `20261113090000`.

### A job: `migrate-with-data`

`test/migrate-with-data/run.sh`, in its own CI job, required by the `ci` gate.

1. **The base commit's migrations, schema and config**, applied with the base's own `prisma migrate deploy`.
   - On a pull request, the base is the merge base with its base branch.
   - On a push to main, it is the main that push replaced.
   - There are no release tags, so the last main is the release.
2. **The base's seed**, `test/migrate-with-data/seed.sql`, loaded as `postgres` (RLS does not apply to it; triggers fire). It holds two compounds, each with:
   - roles, a manager, two residents and a guard;
   - units, and the compound's settings (its time zone);
   - a gate with a night roster, and slots made from it with the old real-time end, one on the 29 → 30 October 2026 night (the case `20261114090000` repairs, its trigger set aside inside one block);
   - app and browser devices;
   - visitor passes (active, used, cancelled);
   - guard instructions (sent before validity existed, scheduled, already told) with their recipients;
   - an invoice with its line, and an office payment.

   Read from the base, the seed always matches the schema it loads into.
3. **The branch's migrations**, as `jiwar_migrator`. Any error fails the job.
4. **Assertions**, each a failure:
   - the migrator role is a superuser or `BYPASSRLS` (the job would no longer be the staging one);
   - a `_prisma_migrations` row is unfinished or rolled back;
   - a migration is not applied, has no file, or was **edited after it was applied** (its stored sha256 against the file; `migrate deploy` itself does not check this);
   - a constraint is left not validated;
   - the database's FORCE RLS tables differ from the scanner's (this keeps the static check honest);
   - a table has fewer rows than before, or was dropped. The exception: a migration new to this branch lists it under `rowsRemoved` in the allowlist file, with the tables and a reason (a dedupe, a purge).
5. **The branch's seed loads** on the new schema. A pull request that changes a seeded table keeps the seed current, and the next base carries it.

It runs as one Postgres service, a cached install and two deploys, in a few minutes.

## Consequences

- **What the job catches** is a migration that fails on rows:
  - a backfill that misses them, followed by a NOT NULL or CHECK they now fail (the R11b-1 shape);
  - a constraint the data violates;
  - an INSERT under FORCE RLS without a compound;
  - an edited applied migration;
  - lost rows.
- **What only the static check catches:** an unscoped UPDATE with nothing after it that fails. It updates no row, silently (the G7 shape), and no database check can tell "no row matched" from "no row needed it".
- **Not checked:**
  - DML built at runtime (`EXECUTE format('UPDATE %I …')`); none of the migrations does it;
  - tables the seed does not fill.
- **Locally:** `pnpm migrations:check`, and `run.sh <base>` against an empty scratch database with both URLs set (never the dev database).

## Open

- The seed grows as migrations need it: a domain whose migrations backfill rows should add its rows here.
