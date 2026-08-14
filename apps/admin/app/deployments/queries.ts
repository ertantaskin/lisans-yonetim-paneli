import 'server-only';
import { apiGet, apiRaw } from '../../lib/api';

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

/** Dağıtım geçmişi (en yeni önce). Dizi veya {items} şekline dayanıklı. */
export async function getDeployments(): Promise<DeploymentRow[]> {
  const data = await apiGet<DeploymentRow[] | { items: DeploymentRow[] }>('/v1/admin/deployments');
  return Array.isArray(data) ? data : (data?.items ?? []);
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
