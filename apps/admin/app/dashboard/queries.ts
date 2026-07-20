import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Genel-bakış (dashboard) ekranı için sunucu-taraflı veri erişimi. ADMIN_TOKEN
 * yalnız Next sunucusunda kalır (apiGet üzerinden). Tipler burada tanımlı; sayfa
 * yalnız `import type` ile alır ('server-only' runtime import istemciye sızmaz).
 */

// ── Tipler (API yanıtı) ──────────────────────────────────────────────────────
export interface DashboardRecentOrder {
  id: string;
  remoteOrderId: string;
  customerEmail: string;
  status: string;
  createdAt: string;
}

export interface DashboardSummary {
  pendingLines: number;
  todayOrders: number;
  lowStockCount: number;
  openReplacements: number;
  openSecurityEvents: number;
  totalAvailableStock: number;
  recentOrders: DashboardRecentOrder[];
}

/** Panel genel-bakış KPI özeti (salt-okunur agregasyon). */
export async function getDashboard(): Promise<DashboardSummary> {
  return apiGet<DashboardSummary>('/v1/admin/dashboard');
}
