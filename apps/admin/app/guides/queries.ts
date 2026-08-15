import 'server-only';
import { apiGet } from '../../lib/api';
import type { GuideRow } from '../../lib/guides';

/**
 * Rehber ekranı + ürün formu için sunucu-taraflı veri erişimi.
 * ADMIN_TOKEN yalnız Next sunucusunda kalır (apiGet).
 *
 * TİPLER burada DEĞİL `lib/guides.ts`'te: istemci bileşenleri de onlara ihtiyaç duyuyor
 * ve bu dosya 'server-only' (bkz. oradaki not).
 */
export type { GuideRow };

export async function getGuides(): Promise<GuideRow[]> {
  const data = await apiGet<GuideRow[] | { items?: GuideRow[] }>('/v1/admin/product-guides');
  return Array.isArray(data) ? data : (data?.items ?? []);
}
