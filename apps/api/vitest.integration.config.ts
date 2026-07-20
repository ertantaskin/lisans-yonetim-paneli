import { defineConfig } from 'vitest/config';

// Entegrasyon testleri — gerçek PostgreSQL'e karşı çalışır (DATABASE_URL zorunlu).
// Servisleri/fonksiyonları doğrudan çağırır (Nest ayağa kaldırmadan); her dosya kendi
// tag'iyle seed edip afterAll'da yalnız kendi eklediklerini siler (global truncate YOK).
// Migration'lar önceden koşmuş olmalı (db:migrate → test:integration).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Testler ortak tabloya dokunur — dosya-içi paralellik kapalı (tag izolasyonu + seri).
    fileParallelism: false,
  },
});
