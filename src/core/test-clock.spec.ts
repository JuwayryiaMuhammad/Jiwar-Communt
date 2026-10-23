import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

// CommonJS on purpose (see the file); shared with eslint.config.mjs.
type TestClock = { testClockConfigs: Linter.Config[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loaded = require('../../eslint.test-clock.cjs') as TestClock;
const { testClockConfigs } = loaded;

/**
 * No test depends on the hour it runs: a day, a time of day or a month in
 * test/ comes from test/setup/compound-clock.ts, never from the UTC date,
 * the runner's local time or a hand-made offset. Lints virtual files with
 * exactly the block the real config uses.
 */
describe('tests read the compound’s day from one helper', () => {
  const repo = join(__dirname, '..', '..');
  const eslint = new ESLint({
    cwd: repo,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...testClockConfigs,
    ],
  });

  async function problems(source: string, filePath = 'test/x/x.e2e-spec.ts') {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.message);
  }

  it.each([
    'const d = new Date().toISOString().slice(0, 10);',
    'const d = at.toISOString().substring(0, 10);',
    "const [d] = new Date().toISOString().split('T');",
    'const w = new Date().getUTCDay();',
    'const h = new Date().getHours();',
    'd.setUTCDate(1);',
    'd.setUTCMonth(d.getUTCMonth() + 2);',
    'const y = born.getUTCFullYear();',
    'const s = new Date().toLocaleDateString();',
    "const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' });",
    'const t = new Date(`${d}T10:00:00+02:00`);',
    'const t = new Date(`${d}T00:00:00.000Z`);',
    "const t = new Date(d + 'T00:00:00Z');",
    "import { localDate } from '../../src/core/common/slots/day-slots';",
    "import { zonedInstant } from '../../src/maintenance/visits/visit-slots';",
    "import { egyptToday } from '../../src/core/common/egyptian-national-id';",
    "import { localMinutes } from '../../src/core/preferences/zoned-time';",
  ])('refuses %s', async (source) => {
    const found = await problems(source);
    expect(found.length).toBeGreaterThan(0);
    for (const message of found)
      expect(message).toContain('test/setup/compound-clock.ts');
  });

  it.each([
    'const d = day(3);',
    'const t = at(day(1), 18);',
    'const until = new Date(Date.now() + 3_600_000);',
    'const iso = new Date().toISOString();',
    'const m = `${month()}-01`;',
    "const s = 'ADR 0014';",
    'const ms = d.getTime();',
    'd.setUTCMilliseconds(0);',
    "import { addDays } from '../../src/core/common/slots/day-slots';",
    "import { day } from '../setup/compound-clock';",
  ])('allows %s', async (source) => {
    expect(await problems(source)).toEqual([]);
  });

  it('leaves the helper itself alone', async () => {
    expect(
      await problems(
        'export const ofDbDate = (v: Date) => v.toISOString().slice(0, 10);',
        'test/setup/compound-clock.ts',
      ),
    ).toEqual([]);
  });

  it.each([
    'const later = new Date(Date.now() + 7 * 86_400_000);',
    'const DAY = 86400000;',
    'const at = new Date(Date.now() + 24 * 3_600_000);',
    'const at = new Date(now.getTime() + 3_600_000 * 24);',
    'const at = new Date(Date.now() + 24 * HOUR);',
    'const start = Date.now() + 24 * 60 * MINUTE;',
    'const until = now + 30 * 24 * HOUR;',
    'const before = now - 31 * 24 * 60 * MINUTE;',
    'const ms = 24 * 60 * 60_000;',
    'const ms = 24 * 60 * 60 * 1000;',
    'const ms = 86_400 * 1_000;',
  ])('refuses a day in milliseconds: %s', async (source) => {
    const found = await problems(source);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('daysLater(n)');
  });

  it.each([
    'const later = daysLater(7);',
    'const at2 = at(day(7), 12);',
    'const perDay = 24 * 60;',
    'const soon = new Date(Date.now() + 2 * 3_600_000);',
    'const start = new Date(Date.now() + (r.inHours ?? 24) * HOUR);',
    [
      '// eslint-disable-next-line no-restricted-syntax -- a real 24 h: the TTL is in ms',
      'const ttl = 86_400_000;',
    ].join('\n'),
  ])('allows %s', async (source) => {
    expect(await problems(source)).toEqual([]);
  });

  it('every test that turns the rule off says why', () => {
    const missing: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.ts'))
          readFileSync(path, 'utf8')
            .split('\n')
            .forEach((line, i) => {
              if (
                /eslint-disable(-next-line|-line)? .*no-restricted-syntax/.test(
                  line,
                ) &&
                !/no-restricted-syntax\s+--\s+\S/.test(line)
              )
                missing.push(`${path}:${i + 1}`);
            });
      }
    };
    walk(join(repo, 'test'));
    expect(missing).toEqual([]);
  });

  it('keeps the base client and the transaction rules in test/', async () => {
    expect(
      await problems(
        "import { BASE_PRISMA } from '../../src/core/database/base-prisma';",
      ),
    ).toHaveLength(1);
    expect(
      await problems('await Promise.all([tx.a.count(), tx.b.count()]);'),
    ).toHaveLength(1);
  });
});
