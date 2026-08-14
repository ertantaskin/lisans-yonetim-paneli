import { defineConfig } from 'vitest/config';

/**
 * Admin paketinin BİRİM testleri.
 *
 * KAPSAM BİLİNÇLİ OLARAK DAR: yalnız `lib/**` altındaki SAF fonksiyonlar
 * (arama katlaması, yapıştırma çözümleyici, para/etiket üretimi). Bunlar operatörün
 * gördüğü sonucu doğrudan belirliyor ve geçmişte SESSİZ hata ürettiler
 * (Türkçe katlama → boş liste, kuruş/lira karışması → yanlış maliyet).
 *
 * environment: 'node' — DOM testi YOK, bu yüzden `jsdom`/`happy-dom` bağımlılığı
 * eklenmedi (React bileşeni test edilmiyor; eklemek kurulum süresini boşuna büyütürdü).
 * Sürüm `@lisans/api` ile HİZALI (vitest ^2.1.8) — sapma pnpm store'unda ikinci bir
 * vitest kurulumu demek.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // Test dosyaları `lib/` altında yaşar; `app/` altındaki saf modüller (ör.
    // stok girişi çözümleyicisi) oradan göreli import edilir — böylece `'use client'`
    // bileşenleriyle aynı klasörde test dosyası birikmez.
    include: ['lib/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**', 'theme-backup/**'],
    passWithNoTests: true,
  },
});
