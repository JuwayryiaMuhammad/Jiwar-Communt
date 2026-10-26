import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import {
  problemsAfter,
  type After,
  type MigrationRow,
  type Snapshot,
} from './migrate-with-data';
import { scanMigrations } from './migrations-rls-check';
import { readAllow, readMigrations } from './migrations-rls-check.cli';

/**
 * The migrate-with-data job's database side (ADR 0061), run by
 * test/migrate-with-data/run.sh:
 *
 *   exec <file.sql>        run a SQL file as the superuser (the seed: RLS
 *                          does not apply to it, triggers still fire)
 *   snapshot <out.json>    rows per table and the migrations applied
 *   assert <in.json>       after the branch's migrations, everything
 *                          problemsAfter() finds; exit 1 on any
 *
 * SUPERUSER_DATABASE_URL reads and seeds; MIGRATOR_DATABASE_URL is the role
 * `prisma migrate deploy` ran as, checked to be what staging uses.
 */
function url(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function withClient<T>(
  connectionString: string,
  run: (c: Client) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString });
  await c.connect();
  try {
    return await run(c);
  } finally {
    await c.end();
  }
}

async function counts(c: Client): Promise<Record<string, number>> {
  const { rows: tables } = await c.query<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      ORDER BY tablename`,
  );
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM "${name}"`,
    );
    out[name] = Number(rows[0].n);
  }
  return out;
}

async function applied(c: Client): Promise<MigrationRow[]> {
  const { rows } = await c.query<{
    migration_name: string;
    checksum: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }>(
    `SELECT migration_name, checksum, finished_at, rolled_back_at
       FROM _prisma_migrations ORDER BY migration_name`,
  );
  return rows.map((r) => ({
    name: r.migration_name,
    checksum: r.checksum,
    finished: r.finished_at !== null,
    rolledBack: r.rolled_back_at !== null,
  }));
}

async function main(): Promise<void> {
  const [command, file] = process.argv.slice(2);
  if (!file)
    throw new Error(
      'usage: exec <file.sql> | snapshot <out.json> | assert <in.json>',
    );
  const superuser = url('SUPERUSER_DATABASE_URL');

  if (command === 'exec') {
    await withClient(superuser, (c) => c.query(readFileSync(file, 'utf8')));
    console.log(`exec ${file}: done`);
    return;
  }

  if (command === 'snapshot') {
    const snapshot: Snapshot = await withClient(superuser, async (c) => ({
      applied: (await applied(c)).map((r) => r.name),
      counts: await counts(c),
    }));
    writeFileSync(file, JSON.stringify(snapshot, null, 2));
    const rows = Object.values(snapshot.counts).reduce((a, b) => a + b, 0);
    console.log(
      `snapshot: ${snapshot.applied.length} migrations applied, ${rows} rows`,
    );
    return;
  }

  if (command === 'assert') {
    const before = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
    const migrator = await withClient(
      url('MIGRATOR_DATABASE_URL'),
      async (c) => {
        const { rows } = await c.query<{
          rolname: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>(
          'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
        );
        return {
          name: rows[0].rolname,
          superuser: rows[0].rolsuper,
          bypassRls: rows[0].rolbypassrls,
        };
      },
    );
    const after: After = await withClient(superuser, async (c) => ({
      migrator,
      migrations: await applied(c),
      notValidated: (
        await c.query<{ name: string }>(
          `SELECT conrelid::regclass::text || '.' || conname AS name
             FROM pg_constraint
            WHERE NOT convalidated AND connamespace = 'public'::regnamespace
            ORDER BY 1`,
        )
      ).rows.map((r) => r.name),
      counts: await counts(c),
      forcedInDb: (
        await c.query<{ name: string }>(
          `SELECT relname AS name FROM pg_class
            WHERE relkind = 'r' AND relforcerowsecurity
              AND relnamespace = 'public'::regnamespace
            ORDER BY relname`,
        )
      ).rows.map((r) => r.name),
    }));
    const files = readMigrations();
    const problems = problemsAfter(before, after, {
      files: Object.fromEntries(
        files.map((f) => [
          f.name,
          createHash('sha256').update(f.sql).digest('hex'),
        ]),
      ),
      forced: scanMigrations(files).forced,
      allow: readAllow(),
    });
    const newer = after.migrations.length - before.applied.length;
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log(
      `assert: ${newer} new migrations applied over ${before.applied.length} with data, as ${migrator.name}; nothing wrong`,
    );
    return;
  }
  throw new Error(`unknown command ${command}`);
}

if (require.main === module)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
