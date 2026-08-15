/**
 * Kurulum / etkinleştirme rehberi tipleri — SUNUCU/İSTEMCİ ORTAK.
 *
 * NEDEN AYRI DOSYA: `app/guides/queries.ts` 'server-only' işaretlidir (ADMIN_TOKEN oradan
 * geçer); istemci bileşenleri (rehber yöneticisi, ürün formu) bu tipleri okuduğu için
 * onları oradan almak istemci paketine server-only modülü sokar ve build kırılır
 * (`lib/categories.ts` ile aynı gerekçe — bu tuzağa bir kez düşüldü).
 */

/** Rehber satırı (API `GET /v1/admin/product-guides`). */
export interface GuideRow {
  id: string;
  title: string;
  body: string;
  /** Bu rehbere bağlı ürün sayısı — 0 ise rehber müşteriye HİÇ ulaşmıyor demektir. */
  productCount: number;
  /** Rehberi kullanan ürün adları (ilk 5) — listede "nerede kullanılıyor" ipucu. */
  productNames: string[];
  updatedAt: string;
}

/** Ürün formunun açılır listesi için yeterli olan dar görünüm (gövde taşınmaz). */
export interface GuideOption {
  id: string;
  title: string;
}
