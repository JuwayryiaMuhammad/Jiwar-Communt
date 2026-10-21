import { join } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

// CommonJS on purpose (see the file); shared with eslint.config.mjs.
type Instants = { instantConfigs: Linter.Config[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loaded = require('../../../../eslint.instants.cjs') as Instants;
const { instantConfigs } = loaded;

/**
 * No body or query field reads a time without its offset (ADR 0025): src
 * takes instants through instant.ts, never `@Type(() => Date)` or
 * `@IsISO8601()`. Lints virtual files with exactly the block the real
 * config uses.
 */
describe('an instant needs its offset', () => {
  const repo = join(__dirname, '..', '..', '..', '..');
  const eslint = new ESLint({
    cwd: repo,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...instantConfigs,
    ],
  });

  async function problems(source: string, filePath = 'src/x/dto/x.dto.ts') {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.message);
  }

  it.each([
    'class A { @Type(() => Date) @IsDate() at: Date; }',
    'class A { @IsISO8601() at: string; }',
    'class A { @IsISO8601({ strict: true }) at: string; }',
    'class A { @IsDateString() at: string; }',
  ])('refuses %s', async (source) => {
    const found = await problems(source);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('instant.ts');
  });

  it.each([
    'class A { @ToInstant() @IsDate() at: Date; }',
    'class A { @IsInstant() at: string; }',
    'class A { @Type(() => Item) @ValidateNested() item: Item; }',
  ])('allows %s', async (source) => {
    expect(await problems(source)).toEqual([]);
  });

  it('keeps the transaction rule in src', async () => {
    expect(
      await problems('void Promise.all([tx.a.count(), tx.b.count()]);'),
    ).toHaveLength(1);
  });
});
