import { resolve } from 'node:path';
import { readAllow, readMigrations } from './migrations-rls-check.cli';
import {
  allowProblems,
  scanMigrations,
  type MigrationFile,
} from './migrations-rls-check';

const FORCE = `CREATE TABLE "things" ("id" UUID, "tenant_id" UUID, "label" TEXT);
ALTER TABLE "things" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "things" FORCE ROW LEVEL SECURITY;
`;
const base: MigrationFile = { name: '20260101000000_things', sql: FORCE };
const scan = (sql: string, allow = {}) =>
  scanMigrations([base, { name: '20260102000000_change', sql }], allow);
const lines = (sql: string) =>
  scan(sql).findings.map((f) => `${f.verb} ${f.table}:${f.line}:${f.problem}`);

const LOOP = (body: string) => `DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    ${body}
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
`;

describe('migrations under FORCE RLS (ADR 0061)', () => {
  it('refuses an UPDATE, INSERT or DELETE on a forced table outside a tenant loop', () => {
    expect(
      lines(`ALTER TABLE "things" ADD COLUMN "n" INT;
UPDATE "things" SET "n" = 1;
INSERT INTO things (id) VALUES (gen_random_uuid());
DELETE FROM "public"."things" WHERE "n" = 0;
`),
    ).toEqual([
      'UPDATE things:2:bare',
      'INSERT things:3:bare',
      'DELETE things:4:bare',
    ]);
  });

  it('takes the statement inside a DO loop that set app.tenant_id first', () => {
    expect(
      lines(
        LOOP(`UPDATE "things" SET "label" = 'x' WHERE "tenant_id" = t."id";`),
      ),
    ).toEqual([]);
  });

  it('refuses one in a DO block whose loop sets no compound, or only clears it', () => {
    expect(
      lines(`DO $$
BEGIN
  PERFORM set_config('app.tenant_id', '', true);
  FOR i IN 1..2 LOOP
    UPDATE "things" SET "label" = 'x';
  END LOOP;
  UPDATE "things" SET "label" = 'y';
END $$;
`),
    ).toEqual(['UPDATE things:5:bare', 'UPDATE things:7:bare']);
    // After the loop ended, its set_config no longer covers the statement.
    expect(
      lines(`DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
  END LOOP;
  UPDATE "things" SET "label" = 'z';
END $$;
`),
    ).toEqual(['UPDATE things:7:bare']);
  });

  it('leaves function bodies alone: a trigger runs later, as the app, with its compound', () => {
    expect(
      lines(`CREATE OR REPLACE FUNCTION touch() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "things" SET "label" = 'x' WHERE "id" = NEW."id";
  RETURN NEW;
END;
$$;
CREATE FUNCTION touch2() RETURNS trigger AS $body$
BEGIN
  DELETE FROM "things" WHERE "id" = OLD."id";
  RETURN NULL;
END;
$body$ LANGUAGE plpgsql;
`),
    ).toEqual([]);
  });

  it('reads no statement in a comment or a string', () => {
    expect(
      lines(`-- UPDATE "things" SET "label" = 'x';
/* DELETE FROM things; */
COMMENT ON TABLE "things" IS 'INSERT INTO things is done by the app';
`),
    ).toEqual([]);
  });

  it('takes a marked statement with a reason, and refuses a marker without one', () => {
    expect(
      lines(`-- rls-dml-allow: the table is empty when this runs, created above
UPDATE "things" SET "label" = 'x';
-- rls-dml-allow:
UPDATE "things" SET "label" = 'y';
`),
    ).toEqual(['UPDATE things:4:empty-reason']);
  });

  it('knows tables forced in a FOREACH loop, and forgets one set to NO FORCE', () => {
    const loop = `DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['a_table',
                           'b_table'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
UPDATE "b_table" SET "x" = 1;
ALTER TABLE "things" NO FORCE ROW LEVEL SECURITY;
UPDATE "things" SET "label" = 'x';
`;
    const r = scan(loop);
    expect(r.findings.map((f) => f.table)).toEqual(['b_table']);
    expect(r.forced).toEqual(['a_table', 'b_table']);
  });

  it('takes a statement that runs before the table is forced', () => {
    expect(
      scanMigrations([
        {
          name: '20260101000000_seed',
          sql: `CREATE TABLE "things" ("id" UUID);
INSERT INTO "things" VALUES (gen_random_uuid());
ALTER TABLE "things" FORCE ROW LEVEL SECURITY;`,
        },
      ]).findings,
    ).toEqual([]);
  });

  it('allowlists by <migration>:<line>, and reports entries that match nothing', () => {
    const r = scan('UPDATE "things" SET "label" = \'x\';\n', {
      '20260102000000_change:1': 'Historic: applied everywhere',
      '20260102000000_change:9': 'Gone',
    });
    expect(r.findings).toEqual([]);
    expect(r.stale).toEqual(['20260102000000_change:9']);
    expect(
      scan('UPDATE "things" SET "label" = \'x\';\n', {
        '20260102000000_change:1': ' ',
      }).findings.map((f) => f.problem),
    ).toEqual(['empty-reason']);
  });

  it('checks the allowlist file itself', () => {
    expect(
      allowProblems(
        {
          bareDml: {
            nope: 'x',
            '20990101_unknown:3': 'x',
            '20260101000000_things:2': '',
          },
          rowsRemoved: {
            '20260101000000_things': { tables: [], reason: '' },
            '20990101_unknown': { tables: ['things'], reason: 'dedupe' },
          },
        },
        ['20260101000000_things'],
      ),
    ).toEqual([
      'bareDml nope: not <migration>:<line>',
      'bareDml 20990101_unknown:3: no such migration',
      'bareDml 20260101000000_things:2: no reason',
      'rowsRemoved 20260101000000_things: no reason',
      'rowsRemoved 20260101000000_things: no tables',
      'rowsRemoved 20990101_unknown: no such migration',
    ]);
  });

  it('the repository’s migrations pass, with the historic two allowlisted', () => {
    const root = resolve(__dirname, '../../..');
    const files = readMigrations(root);
    const allow = readAllow(root);
    expect(
      allowProblems(
        allow,
        files.map((f) => f.name),
      ),
    ).toEqual([]);
    const r = scanMigrations(files, allow.bareDml);
    expect(r.findings).toEqual([]);
    expect(r.stale).toEqual([]);
    // Without the allowlist, exactly those two.
    expect(
      scanMigrations(files).findings.map((f) => `${f.migration}:${f.line}`),
    ).toEqual(Object.keys(allow.bareDml).sort());
    expect(r.forced).toContain('guard_instruction_recipients');
  });
});
