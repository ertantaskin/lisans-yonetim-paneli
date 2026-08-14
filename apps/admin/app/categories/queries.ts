import 'server-only';
import { apiGet } from '../../lib/api';
import type { CategoryRow } from '../../lib/categories';

/**
 * Kategori ekranı ve `/stock` giriş ekranı için sunucu-taraflı veri erişimi.
 * ADMIN_TOKEN yalnız Next sunucusunda kalır (apiGet).
 *
 * TİP ve SABİT burada DEĞİL `lib/categories.ts`'te: istemci bileşenleri de onlara ihtiyaç
 * duyuyor ve bu dosya 'server-only' (bkz. oradaki not).
 */
export type { CategoryRow };

export async function getCategories(): Promise<CategoryRow[]> {
  const data = await apiGet<CategoryRow[] | { items?: CategoryRow[] }>(
    '/v1/admin/product-categories',
  );
  return Array.isArray(data) ? data : (data?.items ?? []);
}
