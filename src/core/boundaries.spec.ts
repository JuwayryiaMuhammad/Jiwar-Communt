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

  it.each([
    ['src/main.ts', "import { rewind } from '../test/setup/sla';"],
    [
      'src/core/sweep/x.ts',
      "import { rewind } from '../../../test/setup/sla';",
    ],
    [
      'src/core/database/x.ts',
      "import { A } from '../../../test/setup/db-module';",
    ],
    [
      'src/maintenance/sla/x.ts',
      "import { rewind } from '../../../test/setup/sla';",
    ],
    ['src/community/units/x.ts', "import { A } from '../../../test';"],
  ])('src → test is rejected (%s)', async (file, source) => {
    const found = await problems(file, source);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('src/ must not import from test/');
  });

  it('the gate domain imports core, and community only through its index.ts', async () => {
    const gate = 'src/gate/visitors/x.ts';
    expect(
      await problems(
        gate,
        "import { A } from '../../core/audit/audit.service';",
      ),
    ).toEqual([]);
    expect(
      await problems(gate, "import { A } from '../../community';"),
    ).toEqual([]);
    expect(
      await problems(gate, "import { A } from '../../community/index';"),
    ).toEqual([]);
    for (const deep of [
      '../../community/residents/residents.service',
      '../../community/workers/schedule',
      '../../community/capabilities/capabilities',
    ]) {
      const found = await problems(gate, `import { A } from '${deep}';`);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain(
        'Import community only through its public index.ts',
      );
    }
  });

  it('community reaches gate only through its index.ts, and core never', async () => {
    const found = await problems(
      'src/community/workers/x.ts',
      "import { A } from '../../gate/shifts/shifts.service';",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('Import gate only through its public index.ts');
    const fromCore = await problems(
      'src/core/sweep/x.ts',
      "import { A } from '../../gate';",
    );
    expect(fromCore).toHaveLength(1);
    expect(fromCore[0]).toContain('src/core must not import a domain');
  });

  it('the maintenance domain imports core and community only through its index.ts, and never the gate (ADR 0032)', async () => {
    const maintenance = 'src/maintenance/tickets/x.ts';
    expect(
      await problems(
        maintenance,
        "import { A } from '../../core/audit/audit.service';",
      ),
    ).toEqual([]);
    expect(
      await problems(maintenance, "import { A } from '../../community';"),
    ).toEqual([]);
    const deep = await problems(
      maintenance,
      "import { A } from '../../community/capabilities/capabilities';",
    );
    expect(deep).toHaveLength(1);
    expect(deep[0]).toContain(
      'Import community only through its public index.ts',
    );
    for (const gate of ['../../gate', '../../gate/entries/verify.service']) {
      const found = await problems(maintenance, `import { A } from '${gate}';`);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('maintenance must not import gate at all');
    }
    const fromCore = await problems(
      'src/core/sweep/x.ts',
      "import { A } from '../../maintenance';",
    );
    expect(fromCore).toHaveLength(1);
    expect(fromCore[0]).toContain('src/core must not import a domain');
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
