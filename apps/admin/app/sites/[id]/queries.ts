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
    salesDailyQuota: number | null;
    sandbox: boolean;
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
