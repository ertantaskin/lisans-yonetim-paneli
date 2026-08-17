import 'server-only';
import { apiGet, apiRaw } from '../../lib/api';
import { DEPLOYMENTS_WINDOW } from '../../lib/deployment-jobs';

/** Dağıtım kaydı (GET /v1/admin/deployments). */
export interface DeploymentRow {
  id: string;
  target: string;
  status: string; // pending | running | success | failed
  requestedBy: string;
  gitSha: string | null;
  log: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DeploymentsData {
  rows: DeploymentRow[];
  /** Yanıt istenen pencereyi DOLDURDU → daha eski kayıtlar bu listede YOK; ekran söyler. */
  truncated: boolean;
}

/**
 * Bu ekranın istediği pencere. Uç artık `?limit=` kabul ediyor (üst sınır 200) → varsayılan
 * 50 yerine daha geniş bir geçmiş alınır; gecelik yedek işleri pencereyi tek başına
 * doldurduğu için 50 satır pratikte "son ~50 gün yalnız yedek" demekti.
 */
export const DEPLOYMENTS_PAGE_LIMIT = 150;

/**
 * Dağıtım geçmişi (en yeni önce). Dizi veya {items} şekline dayanıklı.
 *
 * HEDEF SÜZGECİ BİLEREK YOK — uç artık `?target=` kabul etse de bu çağrı TÜM kuyruğu ister.
 * NEDEN: sayfa bu satırlardan `hasActiveDeployment`i (pending/running var mı) türetiyor ve
 * "aynı anda tek aktif iş" güvencesi HEDEFTEN BAĞIMSIZDIR — çalışan bir `backup` işi de yeni
 * dağıtımı 409 ile reddeder. Listeyi `api/admin/plugin`e daraltmak geçmişi okunur yapardı ama
 * çalışan yedeği GÖRÜNMEZ kılar, dağıtım düğmesi açık kalır ve operatör 409 yerdi. (Bir kümeyi
 * daraltmak, o kümeyi okuyan HER yolu etkiler — bu kod tabanının H1 sınıfı tuzağı.)
 * Yedek işlerinin ayrıntısı ayrıca `backup-summary` kartında hedef başına pencereyle gösterilir.
 */
export async function getDeployments(): Promise<DeploymentsData> {
  const data = await apiGet<DeploymentRow[] | { items: DeploymentRow[] }>(
    `/v1/admin/deployments?limit=${DEPLOYMENTS_PAGE_LIMIT}`,
  );
  const rows = Array.isArray(data) ? data : (data?.items ?? []);
  // Eski API imajı `?limit=`i yok sayıp 50 döndürebilir (dağıtım sapması) → o durumda da
  // kırpma DÜRÜST bildirilsin diye iki eşik de kontrol edilir.
  return {
    rows,
    truncated: rows.length >= DEPLOYMENTS_PAGE_LIMIT || rows.length === DEPLOYMENTS_WINDOW,
  };
}

/** Canlı sistem sağlığı + sürümü (GET /v1/health). Degraded'da 503 döner → apiRaw ile tolere edilir. */
export interface HealthInfo {
  status: string;
  version: string;
  checks?: { db?: boolean; redis?: boolean };
}

export async function getHealth(): Promise<HealthInfo | null> {
  try {
    const res = await apiRaw('GET', '/v1/health');
    return (await res.json()) as HealthInfo;
  } catch {
    return null;
  }
}

/** Yedek / tatbikat işi (deployments kaydından türetilir — ayrı tablo YOK). */
export interface BackupJobInfo {
  id: string;
  target: string; // backup | backup-drill
  status: string; // pending | running | success | failed
  requestedBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationSecs: number | null;
  error: string | null;
  file: string | null;
  sizeBytes: number | null;
  offsite: 'ok' | 'failed' | 'skipped' | null;
  restoreSecs: number | null;
}

/** GET /v1/admin/deployments/backup-summary (§16 DR). */
export interface BackupSummary {
  lastBackupSuccess: BackupJobInfo | null;
  lastBackupAttempt: BackupJobInfo | null;
  lastDrillSuccess: BackupJobInfo | null;
  lastDrillAttempt: BackupJobInfo | null;
  backupAgeHours: number | null;
  drillAgeDays: number | null;
  backupStale: boolean;
  drillStale: boolean;
  activeJob: BackupJobInfo | null;
  thresholds: { backupMaxAgeHours: number; drillMaxAgeDays: number };
  recent: BackupJobInfo[];
}

/**
 * Yedek özeti. DAĞITIM SAPMASINA DAYANIKLI: api ve admin ayrı imajlar, biri önce
 * dağıtılabilir — eski API'de bu uç yoksa ekran hata sınırına düşmez, kart "bilgi
 * alınamadı" der (mevcut getHealth deseni).
 */
export async function getBackupSummary(): Promise<BackupSummary | null> {
  try {
    return await apiGet<BackupSummary>('/v1/admin/deployments/backup-summary');
  } catch {
    return null;
  }
}
