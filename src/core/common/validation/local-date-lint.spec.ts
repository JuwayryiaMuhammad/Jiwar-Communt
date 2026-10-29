import { join } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

// CommonJS on purpose (see the file); shared with eslint.config.mjs.
type Entry = { file: string; name: string; reason: string };
type LocalDates = {
  LOCAL_DATE_ALLOWLIST: Entry[];
  localDatesPlugin: (allowlist?: Entry[]) => ESLint.Plugin;
  localDateConfigs: Linter.Config[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loaded = require('../../../../eslint.local-dates.cjs') as LocalDates;
const { LOCAL_DATE_ALLOWLIST, localDatesPlugin, localDateConfigs } = loaded;

/**
 * A calendar day is one that exists (ADR 0025): a day field takes
 * @IsLocalDate(), and nothing in src checks a day by a pattern of its own.
 * Lints virtual files with exactly the block the real config uses, and the
 * real files of the allowlist with each entry taken out.
 */
describe('a day is one that exists', () => {
  const repo = join(__dirname, '..', '..', '..', '..');
  const parser: Linter.Config = {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
  };
  const lint = (configs: Linter.Config[]) =>
    new ESLint({
      cwd: repo,
      overrideConfigFile: true,
      overrideConfig: [parser, ...configs],
    });
  const eslint = lint(localDateConfigs);

  async function problems(source: string, filePath = 'src/x/dto/x.dto.ts') {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.message);
  }

  it.each([
    // The pattern stands in for the check, whatever the field's name.
    ['class A { @IsString() @Matches(LOCAL_DATE) from: string; }', 1],
    [
      'class A { @IsString({ each: true }) @Matches(LOCAL_DATE, { each: true }) daysOff: string[]; }',
      1,
    ],
    // A field named for a day, with a pattern or a string check alone.
    ['class A { @IsString() @Matches(LOCAL_DATE) paidOn: string; }', 2],
    ['class A { @IsOptional() @IsString() birthDate?: string; }', 1],
    ['class A { @IsString() date: string; }', 1],
    ['class A { @IsOptional() @IsString() day?: string; }', 1],
    // A day's shape of its own, in a decorator or a constant.
    [
      "class A { @Matches(/^\\d{4}-\\d{2}-\\d{2}$/, withParams({ format: 'YYYY-MM-DD' })) from?: string; }",
      1,
    ],
    [
      'class A { @IsString() @Matches(/^\\d{4}-\\d{2}-\\d{2}$/) dueOn: string; }',
      2,
    ],
    ['const DAY = /^\\d{4}-\\d{2}-\\d{2}$/;', 1],
    [
      'export const LOCAL_DATE = /^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$/;',
      1,
    ],
    ['const ok = (d: string) => /\\d{4}-\\d\\d-\\d\\d/.test(d);', 1],
  ])('refuses %s', async (source, count) => {
    const found = await problems(source);
    expect(found).toHaveLength(count);
    for (const message of found) expect(message).toContain('IsLocalDate');
  });

  it.each([
    'class A { @IsString() @IsLocalDate() paidOn: string; }',
    "class A { @IsOptional() @IsLocalDate(withParams({ format: 'YYYY-MM-DD' })) from?: string; }",
    'class A { @IsLocalDate({ each: true }) daysOff: string[]; }',
    // A view: no validator, so no input.
    "class AView { @ApiProperty({ type: String, format: 'date' }) paidOn: string; }",
    // Instants and times of day are not days.
    'class A { @ToInstant() @IsDate() validUntil: Date; }',
    'class A { @IsInstant() from: string; }',
    'class A { @IsString() @Matches(TIME) from: string; }',
    'const MONTH = /^\\d{4}-(0[1-9]|1[0-2])$/;',
    'const TIME = /^([01]\\d|2[0-3]):[0-5]\\d$/;',
    'const INSTANT = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:Z|[+-]\\d{2}:\\d{2})$/i;',
    // Codes and free text take a day among much else: not a day's shape.
    'const CODE = /^[A-Za-z0-9-]{1,20}$/;',
    'class A { @Matches(/^[^%_\\\\]*$/) q: string; }',
  ])('allows %s', async (source) => {
    expect(await problems(source)).toEqual([]);
  });

  it("lets core's local-date.ts hold the shape, and leaves specs alone", async () => {
    const shape = 'export const LOCAL_DATE = /^\\d{4}-\\d{2}-\\d{2}$/;';
    expect(
      await problems(shape, 'src/core/common/validation/local-date.ts'),
    ).toEqual([]);
    expect(await problems(shape, 'src/x/x.spec.ts')).toEqual([]);
  });

  describe('the allowlist', () => {
    const only = (allowlist: Entry[]): Linter.Config[] => [
      {
        files: ['src/**/*.ts'],
        plugins: { 'local-dates': localDatesPlugin(allowlist) },
        rules: { 'local-dates/day-is-local-date': 'error' },
      },
    ];
    const count = async (file: string, allowlist: Entry[]) => {
      const [result] = await lint(only(allowlist)).lintFiles([file]);
      return result.messages.length;
    };

    it('gives every exception its reason', () => {
      expect(LOCAL_DATE_ALLOWLIST.length).toBeGreaterThan(0);
      for (const e of LOCAL_DATE_ALLOWLIST)
        expect(e.reason.trim().length).toBeGreaterThan(20);
    });

    it.each(LOCAL_DATE_ALLOWLIST.map((e) => [`${e.file} ${e.name}`, e]))(
      'still needs %s: without it the file is refused',
      async (_, entry) => {
        const file = entry.file;
        expect(await count(file, LOCAL_DATE_ALLOWLIST)).toBe(0);
        const without = LOCAL_DATE_ALLOWLIST.filter((e) => e !== entry);
        expect(await count(file, without)).toBe(1);
        // An entry without its reason is not honoured.
        const unreasoned = [...without, { ...entry, reason: ' ' }];
        expect(await count(file, unreasoned)).toBe(1);
      },
    );
  });
});
