import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Entegrasyon testleri — gerçek PostgreSQL'e karşı çalışır (DATABASE_URL zorunlu).
// Servisleri/fonksiyonları doğrudan çağırır (Nest ayağa kaldırmadan); her dosya kendi
// tag'iyle seed edip afterAll'da yalnız kendi eklediklerini siler.
// Migration'lar önceden koşmuş olmalı (db:migrate → test:integration).
//
// KOŞU BAŞINDA TAM SIFIRLAMA (`globalSetup`): paket aynı DB'de TEKRAR TEKRAR koşabilsin diye
// tüm tablolar TRUNCATE edilir. Ölçülmüş sorun: kalıntı veri kod regresyonu gibi görünüyordu
// (üst üste koşumlarda hata 1→3→8; taze DB'de tamamı geçiyor). Gerekçenin tamamı ve emniyet
// kilidi (test-olmayan DB adında fail-closed) `test/integration/_global-setup.ts` içinde.
// `cleanupByTag` KALDIRILMADI — artık ikinci savunma hattı (tek koşu içinde dosya izolasyonu).
//
// @lisans/shared package.json'ı main=./dist/index.js gösterir (workspace'te dist YOK —
// API tsc-paths ile KAYNAKTAN tüketir). Vite paket exports'unu çözemediğinden alias ile
// doğrudan kaynağa (src/index.ts) yönlendiriyoruz; build adımı gerekmez.
const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

/**
 * DOSYA SIRASI ALFABETİK SABİTLENİR.
 *
 * Vitest'in varsayılan sıralayıcısı önce sonuç önbelleğine, o yoksa DOSYA BOYUTUNA (büyükten
 * küçüğe) bakar. Yani bir test dosyasına satır eklemek koşum sırasını SESSİZCE değiştirir.
 * Bu paket dosyaları seri koşuyor (`fileParallelism:false`) ve birkaç test GLOBAL tabloyu
 * tarıyor (saklama süpürmesi, incelemedeki siparişler, `allTime` maliyet raporu) — yani sıra
 * gerçekten gözlemlenebilir. Değişken sıra, bir arızayı YENİDEN ÜRETİLEMEZ yapar: aynı kod
 * bir koşumda geçip diğerinde düşebilir ve fark kod değişikliği gibi görünür.
 *
 * Alfabetik sıra "doğru" bir sıra değildir — SABİT bir sıradır; amaç da budur.
 */
class AlfabetikSiralayici {
  async shard<T>(files: T[]): Promise<T[]> {
    // Parçalama (shard) kullanılmıyor; olduğu gibi geçir.
    return files;
  }

  async sort<T extends { moduleId?: string }>(files: T[]): Promise<T[]> {
    return [...files].sort((a, b) => String(a.moduleId ?? '').localeCompare(String(b.moduleId ?? '')));
  }
}

export default defineConfig({
  resolve: {
    alias: { '@lisans/shared': sharedSrc },
  },
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/_global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Testler ortak tabloya dokunur — dosya-içi paralellik kapalı (tag izolasyonu + seri).
    fileParallelism: false,
    sequence: { sequencer: AlfabetikSiralayici as never },
  },
});
