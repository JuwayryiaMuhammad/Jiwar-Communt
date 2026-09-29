import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

// CommonJS on purpose (see the file); shared with eslint.config.mjs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DOMAINS, boundaryConfigs } = require('../../eslint.boundaries.cjs') as {
  DOMAINS: string[];
  boundaryConfigs: Linter.Config[];
};

/**
 * ADR 0015: core never imports a domain; a domain reaches another one only
 * through its index.ts. Lints virtual files with exactly the boundary blocks
 * the real config uses, so a broken pattern fails here, not in review.
 */
describe('import boundaries', () => {
  const repo = join(__dirname, '..', '..');
  const eslint = new ESLint({
    cwd: repo,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...boundaryConfigs,
    ],
  });

  async function problems(filePath: string, source: string) {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((m) => m.message);
  }

  it.each([
    ['src/core/auth/x.ts', "import { A } from '../../community';"],
    ['src/core/auth/x.ts', "import { A } from '../../community/index';"],
    [
      'src/core/access/x.ts',
      "import { A } from '../../community/residents/residents.service';",
    ],
    ['src/core/database/x.ts', "import { A } from '../../community/units';"],
  ])('core → community is rejected (%s: %s)', async (file, source) => {
    const found = await problems(file, source);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('src/core must not import a domain');
  });

  it('a future domain may import core and another domain only through its index.ts', async () => {
    const gate = 'src/gate/visitors/x.ts';
    const gateConfig = new ESLint({
      cwd: repo,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
        // What adding 'gate' to DOMAINS produces for src/gate/**.
        ...boundaryConfigs,
        {
          files: ['src/gate/**/*.ts'],
          rules: {
            'no-restricted-imports': [
              'error',
              {
                patterns: DOMAINS.map((d) => ({
                  group: [`**/${d}/**`, `!**/${d}/index`],
                  message: `Import ${d} only through its public index.ts (ADR 0015).`,
                })),
              },
            ],
          },
        },
      ],
    });
    const lint = async (source: string) =>
      (await gateConfig.lintText(source, { filePath: gate }))[0].messages;

    expect(
      await lint("import { A } from '../../core/audit/audit.service';"),
    ).toEqual([]);
    expect(await lint("import { A } from '../../community';")).toEqual([]);
    expect(await lint("import { A } from '../../community/index';")).toEqual(
      [],
    );
    const internal = await lint(
      "import { A } from '../../community/residents/residents.service';",
    );
    expect(internal).toHaveLength(1);
    expect(internal[0].message).toContain('only through its public index.ts');
  });

  it('a domain may import core', async () => {
    expect(
      await problems(
        'src/community/residents/x.ts',
        "import { A } from '../../core/accounts/account-writer';",
      ),
    ).toEqual([]);
  });

  it('the base Prisma client stays private to src/core/database/', async () => {
    const source = "import { B } from '../database/base-prisma';";
    expect(await problems('src/core/audit/x.ts', source)).toHaveLength(1);
    expect(
      await problems(
        'src/community/units/x.ts',
        "import { B } from '../../core/database/base-prisma';",
      ),
    ).toHaveLength(1);
    expect(await problems('src/core/database/x.ts', source)).toEqual([]);
  });

  it('DOMAINS lists every top-level folder under src/ except core', () => {
    const folders = readdirSync(join(repo, 'src'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'core')
      .map((e) => e.name)
      .sort();
    expect([...DOMAINS].sort()).toEqual(folders);
  });

  it('the real ESLint config applies these blocks', () => {
    const config = readFileSync(join(repo, 'eslint.config.mjs'), 'utf8');
    expect(config).toContain("from './eslint.boundaries.cjs'");
    expect(config).toContain('...boundaryConfigs');
  });
});
