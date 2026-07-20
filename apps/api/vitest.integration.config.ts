import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Entegrasyon testleri — gerçek PostgreSQL'e karşı çalışır (DATABASE_URL zorunlu).
// Servisleri/fonksiyonları doğrudan çağırır (Nest ayağa kaldırmadan); her dosya kendi
// tag'iyle seed edip afterAll'da yalnız kendi eklediklerini siler (global truncate YOK).
// Migration'lar önceden koşmuş olmalı (db:migrate → test:integration).
//
// @jetlisans/shared package.json'ı main=./dist/index.js gösterir (workspace'te dist YOK —
// API tsc-paths ile KAYNAKTAN tüketir). Vite paket exports'unu çözemediğinden alias ile
// doğrudan kaynağa (src/index.ts) yönlendiriyoruz; build adımı gerekmez.
const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@jetlisans/shared': sharedSrc },
  },
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Testler ortak tabloya dokunur — dosya-içi paralellik kapalı (tag izolasyonu + seri).
    fileParallelism: false,
  },
});
