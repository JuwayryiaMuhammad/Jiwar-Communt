// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import boundaries from './eslint.boundaries.cjs';

const { boundaryConfigs } = boundaries;

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'eslint.boundaries.cjs', 'dist/**', 'coverage/**'],
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
  // runInTenantUnsafe takes a tenant id from the caller instead of the request
  // context, so it is a deliberate hole. It is allowed only where there is no
  // request tenant by design: the login bootstrap (src/core/auth/), the
  // platform (src/core/platform/: creating compounds, cross-compound jobs) and
  // the seed. Domain files are added by name: household invite acceptance
  // resolves the compound from the invite link before anyone is logged in
  // (ADR 0005, 0016); the sweep tasks walk every compound in turn (ADR 0021).
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
      'src/community/households/majority-notices.ts',
      'prisma/seed.ts',
    ],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
);
