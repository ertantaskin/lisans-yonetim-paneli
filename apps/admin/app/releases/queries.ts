import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Yayınlanmış eklenti sürümü (GET /v1/admin/updates/plugin yanıtı). Zip GÖVDESİ dönmez —
 * yalnız meta (sürüm/changelog/tarih). Müşteri siteleri public update-checker ile çeker.
 */
export interface ReleaseRow {
  id: string;
  version: string;
  changelog: string | null;
  createdAt: string;
}

/** Yayınlanmış sürümler (en yeni önce). Dizi veya {items} şekline dayanıklı. */
export async function getReleases(): Promise<ReleaseRow[]> {
  const data = await apiGet<ReleaseRow[] | { items: ReleaseRow[] }>('/v1/admin/updates/plugin');
  return Array.isArray(data) ? data : (data?.items ?? []);
}
