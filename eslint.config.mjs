// Flat ESLint config for the monorepo. Type-aware rules are intentionally not enabled (tsc covers types and
// keeps CI lint fast). Rules that fire on established project patterns are warnings, not errors.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      '**/dist/**', '**/node_modules/**', '**/coverage/**', '.local/**', '**/.local/**',
      'packages/core/src/db/types.ts', '**/*.d.ts', 'playwright-report/**', 'test-results/**', 'tests/e2e/artifacts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx,js}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // TypeScript already reports undefined identifiers; no-undef misfires on type-only globals.
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: { 'no-undef': 'off' },
  },
);
