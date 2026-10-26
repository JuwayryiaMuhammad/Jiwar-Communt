import { problemsAfter, type After, type Snapshot } from './migrate-with-data';

const before: Snapshot = {
  applied: ['001_a'],
  counts: { things: 4, others: 2 },
};
const good: After = {
  migrator: { name: 'jiwar_migrator', superuser: false, bypassRls: false },
  migrations: [
    { name: '001_a', checksum: 'h1', finished: true, rolledBack: false },
    { name: '002_b', checksum: 'h2', finished: true, rolledBack: false },
  ],
  notValidated: [],
  counts: { things: 4, others: 3 },
  forcedInDb: ['things'],
};
const expected = {
  files: { '001_a': 'h1', '002_b': 'h2' },
  forced: ['things'],
  allow: { bareDml: {}, rowsRemoved: {} },
};

describe('migrate-with-data: the database after the branch’s migrations (ADR 0061)', () => {
  it('finds nothing wrong when every migration finished over the data', () => {
    expect(problemsAfter(before, good, expected)).toEqual([]);
  });

  it('refuses a superuser or BYPASSRLS migrator: FORCE RLS would not hold for it', () => {
    expect(
      problemsAfter(
        before,
        {
          ...good,
          migrator: { name: 'postgres', superuser: true, bypassRls: true },
        },
        expected,
      ),
    ).toEqual([
      'the migrator postgres is a superuser: FORCE RLS would not hold for it, as it does on staging',
    ]);
  });

  it('reports a migration not finished, not applied, unknown, or changed after it was applied', () => {
    expect(
      problemsAfter(
        before,
        {
          ...good,
          migrations: [
            {
              name: '001_a',
              checksum: 'edited',
              finished: true,
              rolledBack: false,
            },
            {
              name: '003_c',
              checksum: 'h3',
              finished: false,
              rolledBack: false,
            },
          ],
        },
        expected,
      ),
    ).toEqual([
      '001_a: its file changed after it was applied (checksum)',
      '_prisma_migrations: 003_c did not finish (or was rolled back)',
      '_prisma_migrations: 003_c has no migration in the repository',
      '002_b: not applied',
    ]);
  });

  it('reports a constraint left NOT VALID, and a FORCE set the scanner does not know', () => {
    expect(
      problemsAfter(
        before,
        {
          ...good,
          notValidated: ['things.things_label_check'],
          forcedInDb: ['others'],
        },
        expected,
      ),
    ).toEqual([
      'constraint not validated: things.things_label_check',
      'FORCE RLS: the scanner and the database disagree (scanner only: things; database only: others)',
    ]);
  });

  it('refuses rows lost or a table dropped, unless a new migration lists it under rowsRemoved', () => {
    const shrunk = { ...good, counts: { things: 1 } };
    expect(problemsAfter(before, shrunk, expected)).toEqual([
      'things: 4 rows before, 1 after (list it under rowsRemoved with a reason if meant)',
      'others: dropped with 2 rows (list it under rowsRemoved with a reason if meant)',
    ]);
    expect(
      problemsAfter(before, shrunk, {
        ...expected,
        allow: {
          bareDml: {},
          rowsRemoved: {
            '002_b': { tables: ['things', 'others'], reason: 'dedupe' },
          },
        },
      }),
    ).toEqual([]);
    // An entry for a migration that already ran before does not cover a new loss.
    expect(
      problemsAfter(before, shrunk, {
        ...expected,
        allow: {
          bareDml: {},
          rowsRemoved: {
            '001_a': { tables: ['things', 'others'], reason: 'old purge' },
          },
        },
      }),
    ).toHaveLength(2);
  });
});
