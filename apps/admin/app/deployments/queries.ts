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
