// @ts-check
// ============================================================================
// A calendar day is one that exists (ADR 0025)
// ============================================================================
//
// CommonJS on purpose, like eslint.boundaries.cjs: eslint.config.mjs imports
// it, and so does the unit test that proves the rule fires
// (src/core/common/validation/local-date-lint.spec.ts).
//
// A pattern checks a day's shape, not the day: `\d{4}-\d{2}-\d{2}` and
// LOCAL_DATE both let 2026-02-30 through, which `new Date` rolls over to
// 2 March (stored as such) and `'2026-02-30'::date` answers with a 500. A
// body or query day goes through @IsLocalDate(), any other through
// isRealDate() (src/core/common/validation/local-date.ts), the one place
// that knows a day's shape. The rule refuses:
//   - a validated field named for a day (`…On`, `…Date`, `date`, `day`)
//     without @IsLocalDate();
//   - @Matches(LOCAL_DATE), whatever the field is called (`from`, `to`,
//     `validUntil`);
//   - a regex of its own that takes a day (one that accepts 2026-01-01).
// A deliberate exception is a LOCAL_DATE_ALLOWLIST entry, with its reason.

const { relative } = require('node:path');

const HOME = 'src/core/common/validation/local-date.ts';
const USE = `Use @IsLocalDate() on a body or query field, isRealDate() elsewhere (${HOME}, ADR 0025)`;

/**
 * The exceptions: `name` is `Class.field` for a field, the constant's name
 * for a regex. An entry without a reason is not honoured.
 */
const FIRST_OF_MONTH =
  'Day 01 of months 01–12: every value it admits exists. @Matches(FIRST_OF_MONTH) says the plan starts on a month, which @IsLocalDate() cannot.';
const LOCAL_DATE_ALLOWLIST = [
  ...['FIRST_OF_MONTH', 'CreateBillingPlanDto.startsOn'].map((name) => ({
    file: 'src/finance/billing-plans/dto/billing-plans.dto.ts',
    name,
    reason: FIRST_OF_MONTH,
  })),
  ...[
    [
      'src/community/residents/dto/registration.dto.ts',
      'RegistrationRequestDto',
    ],
    ['src/community/workers/dto/workers.dto.ts', 'ReviewDto'],
    ['src/community/workers/dto/workers.dto.ts', 'BirthDateDto'],
    ['src/core/accounts/dto/create-account.dto.ts', 'CreateAccountDto'],
    ['src/core/common/http/identity-document.dto.ts', 'IdentityDocumentDto'],
  ].map(([file, dto]) => ({
    file,
    name: `${dto}.birthDate`,
    reason:
      'checkBirthDate (src/core/common/identity-document.ts) reads the day through isRealDate before any lookup and answers INVALID_BIRTH_DATE {maxAge}, the code the apps show; a national ID carries its own birth date and ignores this one.',
  })),
];

/** Decorators that validate: a field with one of them is input. */
const VALIDATOR =
  /^(Is[A-Z]\w*|Matches|Min|Max|(Min|Max)?Length|Array[A-Z]\w*|Validate(If|Nested|By)?|Allow|Equals|NotEquals|ExclusiveWith)$/;
const DAY_FIELD = /(On|Date)$|^(date|day)$/;
/**
 * A day's shape takes a day and refuses what only looks like one: the day
 * without its dashes, letters in its places, other separators. A code or
 * a free-text pattern (`[A-Z0-9-]+`, `[^%_]*`) takes some of these too.
 */
const SAMPLE_DAY = '2026-01-01';
const NOT_DAYS = ['20260101', 'abcd-ef-gh', '2026x01x01'];

/** A regex literal's `regex` → whether it is a day's shape. */
function takesDay(regex) {
  try {
    const re = new RegExp(regex.pattern, regex.flags.replace(/[gy]/g, ''));
    return re.test(SAMPLE_DAY) && !NOT_DAYS.some((s) => re.test(s));
  } catch {
    return false;
  }
}

function decoratorName(decorator) {
  const e = decorator.expression;
  const callee = e.type === 'CallExpression' ? e.callee : e;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed)
    return callee.property.name;
  return null;
}

/** `Class.field` of the property a node sits in, or the constant it defines. */
function ownerName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier')
      return n.id.name;
    if (n.type === 'PropertyDefinition' && n.key.type === 'Identifier') {
      const cls = n.parent?.parent;
      return `${cls?.id?.name ?? '?'}.${n.key.name}`;
    }
  }
  return null;
}

/**
 * The rule over an allowlist (the real one in the config; the spec takes
 * entries out to prove each one is needed).
 * @param {{ file: string; name: string; reason: string }[]} allowlist
 * @returns {import('eslint').Rule.RuleModule}
 */
function dayIsLocalDate(allowlist) {
  return {
    meta: {
      type: 'problem',
      schema: [],
      messages: {
        dayField: `A day field needs @IsLocalDate(): a pattern or @IsString() alone lets 2026-02-30 through. ${USE}; a deliberate exception goes in LOCAL_DATE_ALLOWLIST (eslint.local-dates.cjs) with its reason.`,
        dayPattern: `@Matches(LOCAL_DATE) checks a day's shape, not the day: 2026-02-30 passes. ${USE}.`,
        dayShape: `A day's shape of its own lets 2026-02-30 through. ${USE}; a deliberate exception goes in LOCAL_DATE_ALLOWLIST (eslint.local-dates.cjs) with its reason.`,
      },
    },
    create(context) {
      const file = relative(context.cwd, context.filename)
        .split('\\')
        .join('/');
      const allowed = new Set(
        allowlist
          .filter((e) => e.file === file && e.reason?.trim())
          .map((e) => e.name),
      );
      return {
        PropertyDefinition(node) {
          const names = (node.decorators ?? []).map(decoratorName);
          if (!names.some((n) => n && VALIDATOR.test(n))) return;
          const field = node.key.type === 'Identifier' ? node.key.name : null;
          for (const d of node.decorators) {
            const e = d.expression;
            if (
              decoratorName(d) === 'Matches' &&
              e.type === 'CallExpression' &&
              e.arguments[0]?.type === 'Identifier' &&
              e.arguments[0].name === 'LOCAL_DATE'
            )
              context.report({ node: d, messageId: 'dayPattern' });
          }
          if (
            field &&
            DAY_FIELD.test(field) &&
            !names.includes('IsLocalDate') &&
            !allowed.has(`${node.parent.parent?.id?.name ?? '?'}.${field}`)
          )
            context.report({ node: node.key, messageId: 'dayField' });
        },
        Literal(node) {
          if (!('regex' in node) || !node.regex || file === HOME) return;
          if (!takesDay(node.regex)) return;
          const owner = ownerName(node);
          if (owner && allowed.has(owner)) return;
          context.report({ node, messageId: 'dayShape' });
        },
      };
    },
  };
}

/** The plugin over an allowlist. */
const localDatesPlugin = (allowlist = LOCAL_DATE_ALLOWLIST) => ({
  rules: { 'day-is-local-date': dayIsLocalDate(allowlist) },
});

/** Flat-config blocks. */
const localDateConfigs = [
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    plugins: { 'local-dates': localDatesPlugin() },
    rules: { 'local-dates/day-is-local-date': 'error' },
  },
];

module.exports = { LOCAL_DATE_ALLOWLIST, localDatesPlugin, localDateConfigs };
