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
