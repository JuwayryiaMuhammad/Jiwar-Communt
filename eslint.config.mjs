// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'coverage/**'],
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
  // Tenant isolation guard rails (ADR 0005)
  // ==========================================================================
  //
  // The raw Prisma client ignores the tenant context: only src/database/ may
  // touch it. Everything else goes through PrismaService.tenant, withTenantTx
  // or GlobalDbService.
  //
  // runInTenantUnsafe takes a tenant id from the caller instead of the request
  // context, so it is a deliberate hole. It is allowed only where there is no
  // request tenant yet by design: the login bootstrap (src/auth/) and the seed.
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/base-prisma', '**/database/base-prisma'],
              message:
                'The base Prisma client bypasses the tenant context. Use PrismaService.tenant, TenantTx or GlobalDbService.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          property: 'runInTenantUnsafe',
          message:
            'runInTenantUnsafe ignores the request tenant. Allowed only in src/auth/ and prisma/seed.ts; use withTenantTx.',
        },
      ],
    },
  },
  {
    files: ['src/database/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    files: ['src/auth/**/*.ts', 'prisma/seed.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
);
