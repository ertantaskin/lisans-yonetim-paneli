import 'server-only';
import { apiGet } from '../../../lib/api';

/**
 * Site detay ekranı için sunucu-taraflı veri erişimi. ADMIN_TOKEN yalnız Next
 * sunucusunda kalır (apiGet üzerinden). Tipler burada; sayfa yalnız `import type`
 * ile alır → 'server-only' runtime import'u istemci paketine sızmaz.
 * SIR (hmac_secret/api_key) API yanıtında zaten yoktur.
 */

export interface SiteDetail {
  site: {
    id: string;
    domain: string;
    type: string;
    status: string;
    senderEmail: string | null;
    webhookUrl: string | null;
    /**
     * Mağaza yönetim paneli sipariş bağlantısı şablonu (`{orderId}`). SALT YÖNLENDİRME —
     * panel bu adrese bağlanmaz. Boş/null → "Mağazada aç" bağlantısı GÖSTERİLMEZ (tahmin
     * üretilmez). Opsiyonel: eski API sürümü bu alanı döndürmeyebilir.
     */
    adminOrderUrlTemplate?: string | null;
    /**
     * Şablonun KAYNAĞI (0026): true = operatör panelden ELLE girdi → mağazanın bildirdiği
     * değer yok sayılır. false/undefined = mağaza bildirebilir (senkron doldurabilir).
     * Opsiyonel: eski API sürümü bu alanı döndürmeyebilir → savunmacı `?? false` okunmalı.
     */
    adminOrderUrlTemplateManual?: boolean;
    salesDailyQuota: number | null;
    sandbox: boolean;
    /** Dinamik satış kotası (§8): açıksa sabit kota yerine 30g-ort × çarpan eşiği uygulanır. */
    dynamicQuotaEnabled: boolean;
    /** Dinamik eşik çarpanı (30g-ort × N, taban 20). */
    reviewMultiplier: number;
    /**
     * Sitede KURULU WP eklenti sürümü (0028) ve en son ne zaman bildirildiği. Sitenin imzalı
     * isteğindeki `x-wpteslimat-version` başlığından öğrenilir → BAĞLANTI SAĞLIĞI kanıtıdır:
     * null ise site panele hiç istek atmamıştır ("aktif" rozeti yalnız 'askıya alınmadı' demek).
     * İmzalanmamış istemci beyanı — yalnız gösterim, yetki kararı verilmez.
     * Opsiyonel: eski API sürümü alanı döndürmeyebilir → savunmacı `?? null` okunmalı.
     */
    pluginVersion?: string | null;
    pluginVersionAt?: string | null;
    createdAt: string;
  };
  mappingCount: number;
  orderCount: number;
  todayOrderCount: number;
  recentOrders: Array<{ id: string; remoteOrderId: string; status: string; createdAt: string }>;
}

/** Tek site 360 görünümü (config + kota kullanımı + son siparişler). */
export async function getSite(id: string): Promise<SiteDetail> {
  return apiGet<SiteDetail>(`/v1/admin/sites/${encodeURIComponent(id)}/detail`);
}
