// @ts-check
// ============================================================================
// An instant needs its offset (ADR 0025)
// ============================================================================
//
// CommonJS on purpose, like eslint.boundaries.cjs: eslint.config.mjs imports
// it, and so does the unit test that proves the rule fires
// (src/core/common/validation/instant-lint.spec.ts).
//
// `@Type(() => Date)` and `@IsISO8601()` take a time without an offset and
// read it in the server's own zone (UTC in the containers): a Cairo 22:00
// would be kept as 01:00 the next day. A body or query instant goes through
// src/core/common/validation/instant.ts instead.

const { TX_CONCURRENCY } = require('./eslint.tx-concurrency.cjs');

const MESSAGE =
  'An instant needs its offset (ADR 0025): a Date field takes @ToInstant() with @IsDate(), a string one @IsInstant() (src/core/common/validation/instant.ts).';

const INSTANT_SYNTAX = [
  {
    selector:
      "Decorator > CallExpression[callee.name='Type'] > ArrowFunctionExpression[body.name='Date']",
    message: MESSAGE,
  },
  {
    selector:
      "Decorator > CallExpression[callee.name=/^(IsISO8601|IsDateString)$/]",
    message: MESSAGE,
  },
];

/** Flat-config blocks, after the tx-concurrency one (which they keep). */
const instantConfigs = [
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', TX_CONCURRENCY, ...INSTANT_SYNTAX],
    },
  },
];

module.exports = { instantConfigs };
