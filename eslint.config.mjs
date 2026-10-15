import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Логгер — единственное место, где разрешён прямой вывод в консоль.
    files: ['src/lib/logger.ts', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  globalIgnores(['.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**', 'docs/**']),
]);
