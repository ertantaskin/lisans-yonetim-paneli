import 'server-only';
import { apiGet } from '../../lib/api';
import { pickJobsByTarget, targetQuery, type TargetJobs } from '../../lib/deployment-jobs';

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

/**
 * Yayın isteği kaydı. Dağıtım kuyruğunun (`deployments`) `target='plugin'` satırları =
 * "kaynaktan eklenti yayınla" istekleri; host runner bunları görüp `publish-plugin.sh`
 * çalıştırır. Aynı tablo olduğu için tek bir kuyruk + tek aktif iş güvencesi geçerlidir.
 */
export interface PluginJobRow {
  id: string;
  target: string;
  status: string; // pending | running | success | failed
  requestedBy: string;
  gitSha: string | null;
  error: string | null;
  note: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Yayın işi kartında gösterilen en fazla satır. */
export const PLUGIN_JOB_TAKE = 5;

/**
 * Sunucudan istenen yayın işi penceresi. `PLUGIN_JOB_TAKE`ten BÜYÜK olmalı: eşit olsaydı
 * "tam 5 yayın işi var" durumu her seferinde kırpma uyarısı gösterirdi (kalıcı yanlış-pozitif).
 * Süzgeç sunucuda olduğu için bu pencereyi yalnız `plugin` işleri doldurur.
 */
export const PLUGIN_JOB_WINDOW = 20;

/**
 * Son eklenti yayın işleri (en yeni önce, en çok 5) + PENCERE DÜRÜSTLÜĞÜ.
 *
 * SÜZGEÇ SUNUCUDA: `?target=plugin` ile YALNIZ yayın işleri istenir. Eskiden uç süzgeç
 * almadığı için karışık kuyruktan 50 satır çekilip burada ayıklanıyordu; gecelik `backup`
 * işleri pencereyi ~50 günde tek başına doldurduğu için ekran gerçek yayınlar dururken
 * "Henüz yayın işi yok" diyordu. `pickJobsByTarget` GENE de uygulanır — eski bir API
 * imajına (süzgeci yok sayan) denk gelen bir admin dağıtımı yanlış hedefi göstermesin
 * diye savunma-derinliği; ayrıca kırpma sinyalini (`windowSaturated`) tek yerden verir.
 */
export async function getPluginJobs(): Promise<TargetJobs<PluginJobRow>> {
  const data = await apiGet<PluginJobRow[] | { items: PluginJobRow[] }>(
    `/v1/admin/deployments${targetQuery(['plugin'], PLUGIN_JOB_WINDOW)}`,
  );
  const rows = Array.isArray(data) ? data : (data?.items ?? []);
  return pickJobsByTarget(rows, 'plugin', PLUGIN_JOB_TAKE, PLUGIN_JOB_WINDOW);
}

/**
 * Site + KURULU eklenti sürümü. Sürüm, sitenin HMAC isteğindeki `x-wpteslimat-version`
 * başlığından öğrenilir (imza kapsamında DEĞİL — yalnız gösterim). Hiç istek gelmemiş
 * ya da eski sürüm (başlığı göndermeyen) site için null kalır.
 */
export interface SitePluginRow {
  id: string;
  domain: string;
  active?: boolean;
  pluginVersion: string | null;
  pluginVersionAt: string | null;
}

export async function getSitePluginVersions(): Promise<SitePluginRow[]> {
  const data = await apiGet<SitePluginRow[] | { items: SitePluginRow[] }>('/v1/admin/sites');
  const rows = Array.isArray(data) ? data : (data?.items ?? []);
  return rows;
}
