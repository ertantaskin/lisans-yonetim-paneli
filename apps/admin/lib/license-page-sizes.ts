/**
 * Lisans envanteri sayfa boyu seçenekleri — ADMIN TARAFI TEK KAYNAK.
 *
 * NEDEN AYRI DOSYA: bu liste ÜÇ yerde ayrı ayrı tanımlanmıştı (tablo bileşeni · sunucu
 * action'ı · API servisi) ve biri güncellenince diğerleri sessizce eskiyordu. Yaşandı:
 * bileşene 10 eklendi, kutuda "10 kayıt" yazdı, ama action listede olmayan değeri ilk
 * seçeneğe (25) düşürdüğü için tablo 25 satır gösterdi — kullanıcıya YALAN söyleyen bir
 * kontrol. Bileşen ve action artık buradan okur.
 *
 * API tarafındaki `LICENSE_PAGE_SIZES` (apps/api/src/stock/stock.service.ts) ayrı bir
 * pakettedir ve gelen değeri EN YAKINA çeker; bu liste onunla BİREBİR aynı kalmalı
 * (orada da bu not duruyor).
 */
export const LICENSE_PAGE_SIZES = [10, 25, 50, 100] as const;
export type LicensePageSize = (typeof LICENSE_PAGE_SIZES)[number];
