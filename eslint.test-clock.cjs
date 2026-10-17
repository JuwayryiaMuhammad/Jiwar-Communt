// @ts-check
// ============================================================================
// Tests read the compound's day from one helper
// ============================================================================
//
// CommonJS on purpose, like eslint.boundaries.cjs: eslint.config.mjs imports
// it, and so does the unit test that proves the rule fires
// (src/core/test-clock.spec.ts).
//
// The server decides "today" as the compound's local day of the database's
// clock (localDate(dbNow, tenant_settings.timezone)). A test that takes the
// UTC date, the runner's local time, or adds n × 24 h (a daylight-saving
// change in between moves the day) agrees with it only at some hours. Every
// day, time of day and month in test/ comes from test/setup/compound-clock.ts,
// the one file this block leaves out.

const { BASE_PRISMA } = require('./eslint.boundaries.cjs');
const { TX_CONCURRENCY } = require('./eslint.tx-concurrency.cjs');

const HELPER = 'test/setup/compound-clock.ts';
const USE = `Use the compound's clock (${HELPER}): day(n), today(), at(), month(), localDay(), dbDate()/ofDbDate().`;

const CLOCK_SYNTAX = [
  {
    selector:
      'CallExpression[callee.property.name=/^(get|set)(UTC)?(FullYear|Month|Date|Day|Hours)$/]',
    message: `A calendar field of the UTC or the runner's clock is not the compound's. ${USE}`,
  },
  {
    selector:
      'CallExpression[callee.property.name=/^(getTimezoneOffset|toLocaleString|toLocaleDateString|toLocaleTimeString)$/]',
    message: `The runner's time zone is not the compound's. ${USE}`,
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(slice|substring|substr|split)$/][callee.object.callee.property.name='toISOString']",
    message: `toISOString() is the UTC day, not the compound's. ${USE}`,
  },
  {
    selector:
      "MemberExpression[object.name='Intl'][property.name='DateTimeFormat']",
    message: `One reading of the compound's calendar, not a local one. ${USE}`,
  },
  {
    selector: 'TemplateElement[value.raw=/^T\\d\\d:\\d\\d/]',
    message: `A date glued to a wall-clock time and a fixed offset ignores the compound's zone. ${USE}`,
  },
  {
    selector: 'Literal[value=/^T\\d\\d:\\d\\d/]',
    message: `A date glued to a wall-clock time and a fixed offset ignores the compound's zone. ${USE}`,
  },
];

// Whatever src module exports them (day-slots, visit-slots re-exports,
// zoned-time, egyptian-national-id).
const CLOCK_IMPORTS = [
  {
    group: ['**/src/**'],
    importNames: [
      'localDate',
      'localParts',
      'localMinutes',
      'zonedInstant',
      'egyptToday',
      'localToday',
    ],
    message: `Turn instants into the compound's days and times through ${HELPER}.`,
  },
];

/** Flat-config blocks, after the boundaries and tx-concurrency ones. */
const testClockConfigs = [
  {
    files: ['test/**/*.ts'],
    ignores: [HELPER],
    rules: {
      'no-restricted-syntax': ['error', TX_CONCURRENCY, ...CLOCK_SYNTAX],
      'no-restricted-imports': [
        'error',
        { patterns: [BASE_PRISMA, ...CLOCK_IMPORTS] },
      ],
    },
  },
];

module.exports = { testClockConfigs };
