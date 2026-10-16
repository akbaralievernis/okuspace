import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Прогон качества AI на настоящей модели (платный): `npm run eval:ai`. В `npm test` не входит. */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/stubs/empty.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/ai-eval/**/*.eval.ts'],
    environment: 'node',
  },
});
