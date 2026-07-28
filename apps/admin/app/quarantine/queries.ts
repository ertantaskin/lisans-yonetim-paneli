import { apiGet, type QuarantineRow } from '../../lib/api';

/**
 * Karantina ekranının veri katmanı (salt-okunur).
 *
 * Neden tek seferde TÜM liste çekiliyor: bu ekranın ana işi "listeyi tedarikçiye ilet" —
 * operatör süzer, sonra ya GÖRÜNEN satırları ya da TÜMÜNÜ CSV olarak indirir. "Tümü" seçeneği
 * ancak tüm kayıtlar tarayıcıda hazırsa dürüst olur (ADMIN_TOKEN tarayıcıya gitmez → istemciden
 * yeniden sorgulanamaz). Bu yüzden süzme/sayfalama İSTEMCİ tarafında yapılır; sunucu yalnız
 * bir kez, üst sınırla okur.
 */

/** Backend üst sınırı (`listQuarantine`: 1..5000). Tek yerden okunur. */
export const QUARANTINE_LIMIT = 5000;

/**
 * Karantina satırı — `GET /v1/admin/quarantine` kaydı.
 *
 * SAVUNMACI TİP: api/admin dağıtımları arasında sapma olabileceği için (yeni alanlar önce
 * backend'e düşer) tüm alanlar opsiyoneldir; yalnız `licenseItemId` (React anahtarı) zorunlu
 * kabul edilir. Ekran her alanı `?? null` ile okur → eski API'ye karşı da ÇÖKMEZ.
 */
export type QuarantineItem = Partial<QuarantineRow> & {
  licenseItemId: string;
  /** Ürün kimliği (süzgeç) + SKU (tedarikçi bildirimi). */
  productId?: string | null;
  sku?: string | null;
  /** Tedarik izi: parti → satın alma emri → tedarikçi. */
  batchId?: string | null;
  batchCode?: string | null;
  supplierId?: string | null;
  supplierName?: string | null;
  /** Stok giriş (import) tarihi — karantina tarihinden AYRI kavram. */
  createdAt?: string | null;
  /** `sourceOrderId`/`sourceRemoteOrderId` ile aynı değerin yeni adları. */
  orderId?: string | null;
  remoteOrderId?: string | null;
  siteDomain?: string | null;
  /** Mağaza panelindeki kaynak sipariş — salt link (yoksa null). */
  storeAdminUrl?: string | null;
};

export interface QuarantineData {
  rows: QuarantineItem[];
  error: string | null;
  /** Üst sınıra dayanıldı → liste kırpılmış olabilir (dışa aktarma eksik kalabilir). */
  truncated: boolean;
}

export async function fetchQuarantine(): Promise<QuarantineData> {
  try {
    const raw = await apiGet<QuarantineItem[]>(
      `/v1/admin/quarantine?limit=${QUARANTINE_LIMIT}`,
    );
    // Beklenmeyen gövde (ör. proxy hata sayfası) tabloyu çökertmesin.
    const rows = Array.isArray(raw) ? raw.filter((r) => r && typeof r.licenseItemId === 'string') : [];
    return { rows, error: null, truncated: rows.length >= QUARANTINE_LIMIT };
  } catch (e) {
    return {
      rows: [],
      error: e instanceof Error ? e.message : 'Bağlantı hatası',
      truncated: false,
    };
  }
}
