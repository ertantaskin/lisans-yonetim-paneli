import { defineConfig } from 'vitest/config';

// Birim testleri. Yarış testi ayrı config'te (vitest.race.config.ts) —
// gerçek PG gerektirir ve CI'da migration'dan sonra koşar.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['test/race/**', 'node_modules/**', 'dist/**'],
    passWithNoTests: true,
  },
});
