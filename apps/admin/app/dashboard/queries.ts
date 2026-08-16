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
  /**
   * Mağaza ürünü panel ürününe bağlı OLMADIĞI için bekleyen satır sayısı.
   *
   * API bunu ZATEN döndürüyordu (`summary()` → `counters.unmappedLines`) ama bu tipte
   * yoktu; canlı şerit düştüğünde sunucu özetinde hazır duran sayaç okunamıyordu.
   * OPSİYONEL: eski API sürümünde alan gelmeyebilir → okuyan `?? null` uygular.
   */
  unmappedLines?: number;
  todayOrders: number;
  lowStockCount: number;
  openReplacements: number;
  openSecurityEvents: number;
  totalAvailableStock: number;
  recentOrders: DashboardRecentOrder[];
  /**
   * GERÇEK TALEP sayacı: en az bir eşlemesiz AKTİF satırı olan sipariş sayısı
   * (eşlemesiz = `product_id IS NULL`, iptal değil, durum pending/partial).
   *
   * DİKKAT — anlam değişti: eskiden `orders.status='unmapped'` (siparişin BÜTÜNÜYLE
   * eşlemesiz olması) idi. Çok kalemli siparişte durum 'pending' olup yalnız bir kalem
   * eşlemesiz olabilir; asıl operatör şikâyeti buydu, o sipariş de artık sayılır.
   *
   * Teslimatı fiilen durduran TEK arıza budur → kırmızı uyarı bandı YALNIZ buradan türetilir.
   * OPSİYONEL: api ve admin ayrı imajlar — biri eski sürümdeyse alan hiç gelmez.
   * Okuma tarafı `?? 0` uygular; 0/undefined ise bant HİÇ çizilmez (yanlış alarm yok).
   */
  unmappedOrders?: number;
  /**
   * BİLGİ sayacı (alarm DEĞİL): mağaza kataloğunda aktif panel eşlemesi olmayan ürün sayısı.
   * Katalog mağazanın TÜM ürünlerini taşır (lisans taşımayanlar dahil) → "eşlenmemiş" ≠
   * "eşlenmesi gereken"; doğru çalışan mağazada da kalıcı > 0 olabilir. Bu yüzden
   * destructive/alarm tonu ASLA bu sayaçtan türetilmez. OPSİYONEL (yukarıdaki gerekçe).
   */
  unmappedCatalogProducts?: number;
}

/** Panel genel-bakış KPI özeti (salt-okunur agregasyon). */
export async function getDashboard(): Promise<DashboardSummary> {
  return apiGet<DashboardSummary>('/v1/admin/dashboard');
}
