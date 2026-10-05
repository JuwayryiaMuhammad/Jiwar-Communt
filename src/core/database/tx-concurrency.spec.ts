import { join } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

// CommonJS on purpose (see the file); shared with eslint.config.mjs.
type TxConcurrency = { txConcurrencyConfigs: Linter.Config[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loaded = require('../../../eslint.tx-concurrency.cjs') as TxConcurrency;
const { txConcurrencyConfigs } = loaded;

/**
 * A transaction client runs one query at a time: pg queues a second one and
 * warns "client.query() while already executing" (an error in pg 9). Lints
 * virtual files with exactly the block the real config uses.
 */
describe('no concurrent queries on a transaction client', () => {
  const repo = join(__dirname, '..', '..', '..');
  const eslint = new ESLint({
    cwd: repo,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...txConcurrencyConfigs,
    ],
  });

  async function problems(source: string) {
    const [result] = await eslint.lintText(source, {
      filePath: 'src/x/x.service.ts',
    });
    return result.messages.map((m) => m.message);
  }

  it.each([
    'await Promise.all([tx.a.count(), tx.b.count()]);',
    'await Promise.allSettled([tx.a.count(), tx.b.count()]);',
    'await Promise.all([tx.a.count(), this.helper(tx, id)]);',
    'await Promise.all([this.globalDb.in(tx).session.count()]);',
    'await Promise.all([global.session.count(), global.outboxMessage.count()]);',
    'await Promise.all(ids.map((id) => tx.a.findUnique({ where: { id } })));',
    'await Promise.all([tx.a.count(), sessionId ? tx.b.count() : null]);',
  ])('rejects %s', async (source) => {
    const found = await problems(source);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('Promise.all over a transaction client');
    expect(found[0]).toContain('Await each query in turn');
  });

  it.each([
    // Not on a transaction client.
    'await Promise.all([this.prisma.tenant.a.count(), this.prisma.tenant.b.count()]);',
    'await Promise.all([a(), b()]);',
    'await Promise.allSettled([db.ping(), redis.ping()]);',
    // Sequential, the fix.
    'const a = await tx.a.count(); const b = await tx.b.count();',
    // Separate transactions on separate connections.
    'await Promise.all(ids.map((id) => this.tenantTx.withTenantTx((tx) => tx.a.count({ where: { id } }))));',
    'await Promise.all([t.withTenantTx(async (tx) => tx.a.count()), t.withTenantTx(async (tx) => tx.b.count())]);',
  ])('allows %s', async (source) => {
    expect(await problems(source)).toEqual([]);
  });
});
