// ============================================================================
// Migrations against a database that holds data (ADR 0061)
// ============================================================================
//
// The e2e suites migrate an empty database, so a migration that only breaks
// on rows (a backfill that misses them, a constraint they fail) passes CI.
// The migrate-with-data job applies the previous main's migrations, loads a
// seed, applies the branch's, and holds the result to what is judged here.
// Pure: the CLI reads the database and feeds it.

import type { MigrationsAllow } from './migrations-rls-check';

export interface Snapshot {
  /** The migrations applied before the branch's, by name. */
  applied: string[];
  /** Rows per table of the public schema. */
  counts: Record<string, number>;
}

export interface MigrationRow {
  name: string;
  checksum: string;
  finished: boolean;
  rolledBack: boolean;
}

export interface After {
  /** The migrator's own role: what `migrate deploy` ran as. */
  migrator: { name: string; superuser: boolean; bypassRls: boolean };
  migrations: MigrationRow[];
  /** `<table>.<constraint>` of every constraint not validated. */
  notValidated: string[];
  counts: Record<string, number>;
  /** Tables with FORCE ROW LEVEL SECURITY in the database. */
  forcedInDb: string[];
}

export interface Expected {
  /** The repository's migrations, by name → sha256 of their file. */
  files: Record<string, string>;
  /** The tables the migrations force, by the scanner. */
  forced: string[];
  allow: MigrationsAllow;
}

/** Everything wrong with the database after the branch's migrations. */
export function problemsAfter(
  before: Snapshot,
  after: After,
  expected: Expected,
): string[] {
  const problems: string[] = [];
  const m = after.migrator;
  if (m.superuser || m.bypassRls)
    problems.push(
      `the migrator ${m.name} is ${m.superuser ? 'a superuser' : 'BYPASSRLS'}: FORCE RLS would not hold for it, as it does on staging`,
    );
  for (const r of after.migrations) {
    if (!r.finished || r.rolledBack)
      problems.push(
        `_prisma_migrations: ${r.name} did not finish (or was rolled back)`,
      );
    const file = expected.files[r.name];
    if (file === undefined)
      problems.push(
        `_prisma_migrations: ${r.name} has no migration in the repository`,
      );
    else if (file !== r.checksum)
      problems.push(
        `${r.name}: its file changed after it was applied (checksum)`,
      );
  }
  const applied = new Set(after.migrations.map((r) => r.name));
  for (const name of Object.keys(expected.files))
    if (!applied.has(name)) problems.push(`${name}: not applied`);
  for (const c of after.notValidated)
    problems.push(`constraint not validated: ${c}`);

  const forced = [...expected.forced].sort().join(',');
  const inDb = [...after.forcedInDb].sort().join(',');
  if (forced !== inDb) {
    const a = new Set(expected.forced);
    const b = new Set(after.forcedInDb);
    const onlyScan = expected.forced.filter((t) => !b.has(t));
    const onlyDb = after.forcedInDb.filter((t) => !a.has(t));
    problems.push(
      `FORCE RLS: the scanner and the database disagree (scanner only: ${onlyScan.join(', ') || '-'}; database only: ${onlyDb.join(', ') || '-'})`,
    );
  }

  const ran = new Set(before.applied);
  const shrinkable = new Map<string, string>();
  for (const [name, entry] of Object.entries(expected.allow.rowsRemoved))
    if (!ran.has(name)) for (const t of entry.tables) shrinkable.set(t, name);
  for (const [table, rows] of Object.entries(before.counts)) {
    const now = after.counts[table];
    if (now !== undefined && now >= rows) continue;
    if (shrinkable.has(table)) continue;
    problems.push(
      now === undefined
        ? `${table}: dropped with ${rows} rows (list it under rowsRemoved with a reason if meant)`
        : `${table}: ${rows} rows before, ${now} after (list it under rowsRemoved with a reason if meant)`,
    );
  }
  return problems;
}
