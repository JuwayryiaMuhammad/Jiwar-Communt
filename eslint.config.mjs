// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import boundaries from './eslint.boundaries.cjs';
import instants from './eslint.instants.cjs';
import testClock from './eslint.test-clock.cjs';
import txConcurrency from './eslint.tx-concurrency.cjs';

const { boundaryConfigs } = boundaries;
const { txConcurrencyConfigs } = txConcurrency;
const { testClockConfigs } = testClock;
const { instantConfigs } = instants;

export default tseslint.config(
  {
    // apps/ and packages/ are the Next.js dashboards, checked by their own tsc.
    ignores: [
      'eslint.config.mjs',
      'eslint.boundaries.cjs',
      'eslint.instants.cjs',
      'eslint.tx-concurrency.cjs',
      'eslint.test-clock.cjs',
      'dist/**',
      'coverage/**',
      'apps/**',
      'packages/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  // ==========================================================================
  // Tenant isolation guard rails (ADR 0005) and import boundaries (ADR 0015)
  // ==========================================================================
  //
  // The raw Prisma client ignores the tenant context: only src/core/database/
  // may touch it. Everything else goes through PrismaService.tenant,
  // withTenantTx or GlobalDbService. core must not import a domain, and a
  // domain reaches another one only through its index.ts. See
  // eslint.boundaries.cjs (shared with the unit test that proves it fires).
  ...boundaryConfigs,
  // ==========================================================================
  // One query at a time on a transaction client (eslint.tx-concurrency.cjs)
  // ==========================================================================
  ...txConcurrencyConfigs,
  // ==========================================================================
  // An instant needs its offset (eslint.instants.cjs, ADR 0025)
  // ==========================================================================
  ...instantConfigs,
  // ==========================================================================
  // Tests read the compound's day from one helper (eslint.test-clock.cjs)
  // ==========================================================================
  ...testClockConfigs,
  // runInTenantUnsafe takes a tenant id from the caller instead of the request
  // context, so it is a deliberate hole. It is allowed only where there is no
  // request tenant by design: the login bootstrap (src/core/auth/), the
  // platform (src/core/platform/: creating compounds, cross-compound jobs) and
  // the seed. Domain files are added by name: household invite acceptance
  // resolves the compound from the invite link before anyone is logged in
  // (ADR 0005, 0016); the sweep tasks walk every compound in turn (ADR 0021);
  // SweepRunner.forEachTenant does that for every later task (ADR 0027);
  // the visitor page resolves the compound from the link's global pointer,
  // with no account at all (ADR 0030); the push worker claims deliveries
  // across compounds and reads each one's notification in its own (ADR 0041);
  // the email outbox records a formal notice's email in its compound (ADR
  // 0058).
  // Finance (ADR 0046): the platform changes a compound's gateway, the
  // Paymob webhook resolves the compound from its URL, the public receipt
  // page from the code's global pointer, and the boot check and the
  // re-encryption CLI walk every compound.
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'runInTenantUnsafe',
          message:
            'runInTenantUnsafe ignores the request tenant. Allowed only in src/core/auth/, src/core/platform/, the files named in eslint.config.mjs and prisma/seed.ts; use withTenantTx.',
        },
      ],
    },
  },
  {
    files: [
      'src/core/database/**/*.ts',
      'src/core/auth/**/*.ts',
      'src/core/platform/**/*.ts',
      'src/community/households/invite-acceptance.service.ts',
      'src/community/proxies/proxy-acceptance.service.ts',
      'src/community/households/majority-notices.ts',
      'src/community/residents/registration.service.ts',
      'src/community/residents/registration-documents.service.ts',
      'src/core/accounts/account-deletion.service.ts',
      'src/core/push/push-processor.ts',
      'src/core/mail/outbox-processor.ts',
      'src/core/sweep/sweep-runner.ts',
      'src/gate/visitors/visitor-page.service.ts',
      'src/partners/desk/desk.service.ts',
      'src/gate/children/pickup-page.service.ts',
      'src/finance/gateway/platform-gateway.service.ts',
      'src/finance/gateway/gateway-keys.ts',
      'src/finance/online/paymob-webhook.service.ts',
      'src/finance/receipts-public/receipt-page.service.ts',
      'src/finance/clearances/clearance-page.service.ts',
      'prisma/seed.ts',
    ],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
);
