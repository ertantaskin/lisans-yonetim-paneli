import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Raporlar ekranı için sunucu-taraflı veri erişimi. ADMIN_TOKEN yalnız Next
 * sunucusunda kalır (apiGet üzerinden). Tipler burada tanımlı; view/sayfa
 * yalnız `import type` ile alır (type-only import derlemede silinir → 'server-only'
 * runtime import'u istemci paketine sızmaz).
 */

// ── Tipler (API yanıtı: GET /v1/admin/reports/overview) ──────────────────────
export interface ReportsOverview {
  orders: {
    total: number;
    /** Sipariş durumu → adet (örn { fulfilled: 12, partial: 3, ... }). */
    byStatus: Record<string, number>;
  };
  fulfillment: {
    /** order_lines toplam satır. */
    lines: number;
    fulfilled: number;
    partial: number;
    pending: number;
  };
  stock: {
    /** Tüm ürünlerdeki kullanılabilir birim toplamı. */
    totalAvailable: number;
    byProduct: Array<{ productId: string; sku: string; name: string; available: number }>;
  };
  /** Satış hızı: son 7/30 gün atama; günlük oran + kalan gün tahmini. */
  velocity: Array<{
    productId: string;
    sku: string;
    sold7d: number;
    sold30d: number;
    dailyRate: number;
    /** available/dailyRate; oran 0 ise null (tükenme öngörülemez). */
    daysRemaining: number | null;
  }>;
  replacements: {
    total: number;
    approved: number;
    /** approved / max(total, 1) — 0..1 arası oran. */
    rate: number;
  };
}

/** Rapor özeti (salt-okunur agregasyon). */
export async function getReportsOverview(): Promise<ReportsOverview> {
  return apiGet<ReportsOverview>('/v1/admin/reports/overview');
}

// ── Teslimat süresi (SLA) — GET /v1/admin/reports/sla?days=N ─────────────────
// Sözleşme API'deki `SlaReport` ile BİREBİR (apps/api/src/reports/sla.service.ts).

/** Bir kovanın süre istatistiği (saniye). Ortalama tek başına yanıltıcı → p50/p95 zorunlu. */
export interface SlaStats {
  avgSeconds: number | null;
  p50Seconds: number | null;
  p95Seconds: number | null;
  maxSeconds: number | null;
}

export interface SlaBucket {
  /** Ölçüme giren (tamamı teslim edilmiş) sipariş/satır. */
  measured: number;
  /** Bekleme = 0 → sipariş ile aynı transaction'da teslim edildi. */
  instant: number;
  /** Bekleme > 0 → stok/tamamlama bekledi. */
  waited: number;
  /** Kohortta hâlâ tamamlanmamış (ölçüme giremeyen). */
  stillOpen: number;
  waitedStats: SlaStats;
  overallStats: SlaStats;
}

export interface SlaDailyRow extends SlaBucket {
  /** Yerel gün (YYYY-MM-DD) — siparişin düştüğü gün (kohort). */
  day: string;
}

export interface SlaBreakdownRow extends SlaBucket {
  id: string;
  label: string;
  /** Ürün kırılımında SKU; mağaza kırılımında null. */
  sku: string | null;
}

export interface SlaReport {
  generatedAt: string;
  windowDays: number;
  from: string;
  to: string;
  totals: SlaBucket;
  daily: SlaDailyRow[];
  bySite: SlaBreakdownRow[];
  byProduct: SlaBreakdownRow[];
  truncated: { bySite: boolean; byProduct: boolean };
  excluded: {
    heldOrders: number;
    canceledLines: number;
    bonusLines: number;
    /**
     * Ölçülebilir satırı olmayan sipariş (hiç satırı yok ya da TÜM satırları elendi).
     * Ne `measured`'a ne `stillOpen`'a girer → sayılmasa iki sayacın toplamı sipariş
     * sayısını tutmaz. Opsiyonel: eski API sürümüyle de çalışır (dağıtım sapması).
     */
    ordersWithoutMeasurableLines?: number;
  };
}

/** Panelin sunduğu pencere seçenekleri (API üst sınırı 90 gün). */
export const SLA_DAY_OPTIONS = [7, 14, 30, 90] as const;

/** Geçersiz/eksik `days` → 30 (API de aynı şekilde varsayılana düşer; ekran boşalmaz). */
export function normalizeSlaDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  const found = SLA_DAY_OPTIONS.find((d) => d === Math.floor(n));
  return found ?? 30;
}

/** Teslimat süresi raporu. `days` normalize edilmiş olmalı (yalnız sabit seçenekler). */
export async function getSlaReport(days: number): Promise<SlaReport> {
  const qs = new URLSearchParams({ days: String(days) }).toString();
  return apiGet<SlaReport>(`/v1/admin/reports/sla?${qs}`);
}

// ── Yeniden-sipariş önerisi — GET /v1/admin/reports/reorder ──────────────────
// Sözleşme API'deki `ReorderReport` ile BİREBİR (apps/api/src/reports/reorder.service.ts).

export type ReorderStatus = 'out' | 'order_now' | 'watch' | 'ok' | 'unknown_lead';

export interface ReorderRow {
  productId: string;
  sku: string;
  name: string;
  usageMode: 'single' | 'multi';
  /** multi'de anahtar başına kullanım hakkı (birim ↔ adet çevirisi). */
  unitsPerKey: number;
  available: number;
  soldUnits: number;
  dailyRate: number;
  daysRemaining: number | null;
  stockoutOn: string | null;
  supplierId: string | null;
  supplierName: string | null;
  /** null = tedarik süresi bilinmiyor (varsayılan UYDURULMAZ). */
  leadDays: number | null;
  openOrderKeys: number;
  openOrderUnits: number;
  reorderPointUnits: number | null;
  suggestedUnits: number | null;
  suggestedKeys: number | null;
  lowStockThreshold: number | null;
  belowFixedThreshold: boolean;
  status: ReorderStatus;
}

export interface ReorderReport {
  generatedAt: string;
  /** Formülün girdileri — ekrandaki açıklama bu değerlerden yazılır (tek kaynak). */
  params: { windowDays: number; safetyDays: number; coverDays: number };
  rows: ReorderRow[];
  counts: Record<ReorderStatus, number>;
  truncated: boolean;
  excluded: { stocklessProducts: number; noSalesProducts: number };
}

/** Yeniden-sipariş önerisi (parametresiz — formül sabitleri sunucuda). */
export async function getReorderReport(): Promise<ReorderReport> {
  return apiGet<ReorderReport>('/v1/admin/reports/reorder');
}
