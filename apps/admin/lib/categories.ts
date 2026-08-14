/**
 * Kategori tipleri ve sabitleri — SUNUCU/İSTEMCİ ORTAK.
 *
 * NEDEN AYRI DOSYA: `app/categories/queries.ts` 'server-only' işaretlidir (ADMIN_TOKEN
 * oradan geçer). İstemci bileşenleri (kategori kartı, yönetim paneli) buradan yalnız TİP
 * alsaydı sorun olmazdı — ama `UNCATEGORIZED` bir ÇALIŞMA ZAMANI değeri; onu server-only
 * dosyadan almak istemci paketine o modülü sokar ve build "server-only in a Client
 * Component" ile kırılır (bu partide bir kez yaşandı). Ortak sabit/tip burada durur.
 */

/** Kategorisiz kovanın sanal id'si — API `UNCATEGORIZED_ID` ile BİREBİR aynı sabit. */
export const UNCATEGORIZED = 'none';

/** Kategori kartı satırı (API `GET /v1/admin/product-categories`). */
export interface CategoryRow {
  /** Gerçek kategori id'si; kategorisiz kova için sabit 'none' (sanal). */
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  productCount: number;
  /** Kategorideki ürünlerin ATANABİLİR stok toplamı (kapasite). */
  availableStock: number;
  /** Düşük stok eşiğinin altına düşmüş ürün sayısı. */
  lowStockCount: number;
}
