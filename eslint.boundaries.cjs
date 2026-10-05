// @ts-check
// ============================================================================
// Import boundaries (ADR 0005, ADR 0015)
// ============================================================================
//
// CommonJS on purpose: eslint.config.mjs imports it, and so does the unit test
// that proves the rules fire (src/core/boundaries.spec.ts), without loading
// the whole typed ESLint config.
//
// - The raw Prisma client ignores the tenant context: only src/core/database/
//   may import it.
// - src/core/ is shared by every domain and must not depend on any of them.
// - A domain (src/community/, src/gate/, …) may import core freely, and
//   another domain only through that domain's public index.ts.
//
// `no-restricted-imports` is one rule: a later config block REPLACES the
// options of an earlier one. So every block below is built from the same
// pieces and each carries every pattern that applies to its files.

/** Top-level domain folders under src/. The unit test keeps this in sync with the disk. */
const DOMAINS = ['community', 'gate', 'maintenance'];

/**
 * Domains a domain must not import at all, not even through the index:
 * maintenance reads community only (ADR 0032).
 */
const NO_IMPORT = { maintenance: ['gate'] };

const BASE_PRISMA = {
  group: ['**/base-prisma', '**/database/base-prisma'],
  message:
    'The base Prisma client bypasses the tenant context. Use PrismaService.tenant, TenantTx or GlobalDbService.',
};

/**
 * Nothing under src/ imports from test/: the test helpers include a time
 * machine that rewrites append-only history as a superuser (ADR 0034), and
 * must never be reachable from the app.
 */
const SRC_TO_TEST = {
  group: ['**/test', '**/test/**'],
  message:
    'src/ must not import from test/ (test helpers bypass the database guards).',
};

const CORE_TO_DOMAIN = {
  group: DOMAINS.flatMap((d) => [`**/${d}`, `**/${d}/**`]),
  message:
    'src/core must not import a domain (ADR 0015). Put the shared piece in core, or let the domain register a hook.',
};

/** From inside `domain`: other domains only through their index.ts. */
function otherDomainsInternals(domain) {
  const banned = NO_IMPORT[domain] ?? [];
  return DOMAINS.filter((d) => d !== domain).map((d) =>
    banned.includes(d)
      ? {
          group: [`**/${d}`, `**/${d}/**`],
          message: `${domain} must not import ${d} at all (ADR 0032).`,
        }
      : {
          group: [`**/${d}/**`, `!**/${d}/index`],
          message: `Import ${d} only through its public index.ts (ADR 0015).`,
        },
  );
}

function rule(patterns) {
  return ['error', { patterns }];
}

/** Flat-config blocks, in order. */
const boundaryConfigs = [
  {
    files: ['**/*.ts'],
    rules: { 'no-restricted-imports': rule([BASE_PRISMA]) },
  },
  {
    files: ['src/**/*.ts'],
    rules: { 'no-restricted-imports': rule([BASE_PRISMA, SRC_TO_TEST]) },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': rule([BASE_PRISMA, CORE_TO_DOMAIN, SRC_TO_TEST]),
    },
  },
  {
    // The one place allowed to build and hold the raw client.
    files: ['src/core/database/**/*.ts'],
    rules: { 'no-restricted-imports': rule([CORE_TO_DOMAIN, SRC_TO_TEST]) },
  },
  ...DOMAINS.map((domain) => ({
    files: [`src/${domain}/**/*.ts`],
    rules: {
      'no-restricted-imports': rule([
        BASE_PRISMA,
        SRC_TO_TEST,
        ...otherDomainsInternals(domain),
      ]),
    },
  })),
];

module.exports = { DOMAINS, boundaryConfigs };
