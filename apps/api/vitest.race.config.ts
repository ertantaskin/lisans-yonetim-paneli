import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Yarış testi — gerçek PostgreSQL'e karşı çalışır (DATABASE_URL).
// CI'da zorunlu (§16): 100 eşzamanlı sipariş × 50 stok → çifte atama = 0.
//
// @lisans/shared'ı entegrasyon config'i gibi KAYNAKTAN çöz (workspace'te dist YOK; vite
// paket exports'unu çözemez). Alias olmadan node_modules symlink'ine düşerdi (rename sonrası
// bayat kalabilir) → import çözümü kırılırdı.
const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@lisans/shared': sharedSrc },
  },
  test: {
    environment: 'node',
    include: ['test/race/**/*.race.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Tek dosya, kendi eşzamanlılığını yönetir — vitest paralelliği kapalı.
    fileParallelism: false,
  },
});
