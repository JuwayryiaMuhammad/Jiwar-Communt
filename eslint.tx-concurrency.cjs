// @ts-check
// ============================================================================
// No concurrent queries on a transaction client
// ============================================================================
//
// CommonJS on purpose, like eslint.boundaries.cjs: eslint.config.mjs imports
// it, and so does the unit test that proves the rule fires
// (src/core/database/tx-concurrency.spec.ts).
//
// A Prisma interactive transaction owns one pg connection. Starting a second
// query on it while the first is running (`Promise.all([tx.a.count(),
// tx.b.count()])`) queues it inside pg: "client.query() while already
// executing" is deprecated and becomes an error in pg 9. Await each query in
// turn instead.
//
// The names are the ones the codebase uses: `tx` (TenantTxClient, and the
// client behind GlobalDbService.transaction) and `global` (the global tables
// read through `this.globalDb.in(tx)`). A Promise.all that declares its own
// `tx` inside (`withTenantTx((tx) => …)` per element) opens separate
// transactions on separate connections and is allowed.

const SELECTOR = [
  "CallExpression[callee.object.name='Promise']",
  '[callee.property.name=/^(all|allSettled|race|any)$/]',
  ":not(:has(:function[params.0.name='tx']))",
  ':has(Identifier[name=/^(tx|global)$/])',
].join('');

const MESSAGE =
  'Promise.all over a transaction client runs concurrent queries on one connection (pg: "client.query() while already executing", an error in pg 9). Await each query in turn. Parallel work belongs in separate transactions, each opened with its own withTenantTx.';

const txConcurrencyConfigs = [
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: SELECTOR, message: MESSAGE },
      ],
    },
  },
];

module.exports = { txConcurrencyConfigs };
