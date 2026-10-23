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

// A day in milliseconds: n × 24 h is the compound's n days only when no
// clock change falls in between (Egypt's does, every spring and autumn).
// "Days later" comes from the helper (daysLater, day, at). A real 24-hour
// duration the server measures in milliseconds (a TTL, a retention cutoff)
// stays, with `// eslint-disable-next-line no-restricted-syntax -- <why>`:
// the unit test of this file refuses a disable without its reason.
const DAY_MS = `A day in milliseconds is 24 h, not one of the compound's days: a clock change in between moves it. Use daysLater(n), day(n) or at() from ${HELPER}; a real 24-hour duration the server measures in ms takes "// eslint-disable-next-line no-restricted-syntax -- <why>".`;
const DAY_MS_SYNTAX = [
  // 86_400_000 and 86400000.
  { selector: 'Literal[value=86400000]', message: DAY_MS },
  // 86_400 * 1_000.
  {
    selector:
      "BinaryExpression[operator='*'][left.value=86400][right.value=1000]",
    message: DAY_MS,
  },
  // 24 * 3_600_000, either way round.
  {
    selector:
      "BinaryExpression[operator='*'][left.value=24][right.value=3600000]",
    message: DAY_MS,
  },
  {
    selector:
      "BinaryExpression[operator='*'][left.value=3600000][right.value=24]",
    message: DAY_MS,
  },
  // 24 * HOUR (any constant named for an hour).
  {
    selector:
      "BinaryExpression[operator='*'][left.value=24][right.name=/^(HOUR|HOURS|HOUR_MS|ONE_HOUR)$/]",
    message: DAY_MS,
  },
  // n * 24 * HOUR.
  {
    selector:
      "BinaryExpression[operator='*'][left.operator='*'][left.right.value=24][right.name=/^(HOUR|HOURS|HOUR_MS|ONE_HOUR)$/]",
    message: DAY_MS,
  },
  // 24 * 60 * MINUTE, n * 24 * 60 * MINUTE, 24 * 60 * 60_000 and
  // 24 * 60 * 60 * 1000.
  {
    selector:
      "BinaryExpression[operator='*'][left.type='BinaryExpression'][left.left.value=24][left.right.value=60][right.name=/^(MINUTE|MINUTES|MINUTE_MS|ONE_MINUTE)$/]",
    message: DAY_MS,
  },
  {
    selector:
      "BinaryExpression[operator='*'][left.operator='*'][left.left.operator='*'][left.left.right.value=24][left.right.value=60][right.name=/^(MINUTE|MINUTES|MINUTE_MS|ONE_MINUTE)$/]",
    message: DAY_MS,
  },
  {
    selector:
      "BinaryExpression[operator='*'][left.left.value=24][left.right.value=60][right.value=60000]",
    message: DAY_MS,
  },
  {
    selector:
      "BinaryExpression[operator='*'][right.value=1000][left.right.value=60][left.left.left.value=24][left.left.right.value=60]",
    message: DAY_MS,
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
      'no-restricted-syntax': [
        'error',
        TX_CONCURRENCY,
        ...CLOCK_SYNTAX,
        ...DAY_MS_SYNTAX,
      ],
      'no-restricted-imports': [
        'error',
        { patterns: [BASE_PRISMA, ...CLOCK_IMPORTS] },
      ],
    },
  },
];

module.exports = { testClockConfigs };
