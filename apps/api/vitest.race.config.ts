import { defineConfig } from 'vitest/config';

// Yarış testi — gerçek PostgreSQL'e karşı çalışır (DATABASE_URL).
// CI'da zorunlu (§16): 100 eşzamanlı sipariş × 50 stok → çifte atama = 0.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/race/**/*.race.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Tek dosya, kendi eşzamanlılığını yönetir — vitest paralelliği kapalı.
    fileParallelism: false,
  },
});
