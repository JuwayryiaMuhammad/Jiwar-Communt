import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  allowProblems,
  scanMigrations,
  type MigrationsAllow,
} from './migrations-rls-check';

export const MIGRATIONS_DIR = 'prisma/migrations';
export const ALLOW_FILE = 'prisma/migrations-rls-allow.json';

/** Every migration directory's SQL, in name order. */
export function readMigrations(root = process.cwd()) {
  const dir = resolve(root, MIGRATIONS_DIR);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(dir, name, 'migration.sql'), 'utf8'),
    }));
}

export function readAllow(root = process.cwd()): MigrationsAllow {
  return JSON.parse(
    readFileSync(resolve(root, ALLOW_FILE), 'utf8'),
  ) as MigrationsAllow;
}

/**
 * `pnpm migrations:check` (ADR 0061): every UPDATE, INSERT or DELETE on a
 * FORCE RLS table outside a loop setting `app.tenant_id` fails, unless it
 * is marked (`-- rls-dml-allow: <reason>`) or allowlisted. `--forced`
 * prints the tables under FORCE RLS instead, one per line, for the
 * migrate-with-data job to hold against the database.
 */
function main(): void {
  const files = readMigrations();
  const allow = readAllow();
  const result = scanMigrations(files, allow.bareDml);
  if (process.argv.includes('--forced')) {
    console.log(result.forced.join('\n'));
    return;
  }
  const problems = [
    ...allowProblems(
      allow,
      files.map((f) => f.name),
    ),
    ...result.stale.map(
      (k) => `${ALLOW_FILE}: ${k} matches no unscoped statement`,
    ),
    ...result.findings.map(
      (f) =>
        `${MIGRATIONS_DIR}/${f.migration}/migration.sql:${f.line}: ${f.verb} ${f.table} ` +
        (f.problem === 'bare'
          ? 'on a FORCE RLS table outside a loop that sets app.tenant_id'
          : 'is marked without a reason'),
    ),
  ];
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(
      '\nThe migrator is not a superuser: under FORCE RLS it sees no compound unless the statement runs in a loop that sets app.tenant_id (ADR 0061).',
    );
    process.exit(1);
  }
  console.log(
    `migrations:check: ${files.length} migrations, ${result.forced.length} FORCE RLS tables, no unscoped statement`,
  );
}

if (require.main === module) main();
