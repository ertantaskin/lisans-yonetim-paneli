import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Güvenlik olayı satırı (GET /v1/admin/security-events yanıtı, DESC).
 * security_events tablosu: velocity/quota_exceeded/anomaly/blocklist tipleri.
 */
export interface SecurityEventRow {
  id: string;
  type: string;
  severity: string;
  siteId: string | null;
  /** Olayın site alan adı (API sites LEFT JOIN'i döndürür; site yoksa/silinmişse null). */
  siteDomain: string | null;
  subject: string | null;
  detail: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * API tarafındaki SABİT üst sınır (`security.service.listEvents` → `LIMIT 500`). Sunucu
 * sayfalama sunmadığı ve süzme/arama/facet TAMAMEN istemcide bu pencere üzerinde çalıştığı
 * için istemci sınırı BİLMEK zorunda: her başarılı/başarısız yönetici girişi de olay ürettiğinden
 * pencere hızla dolar; bir brute-force dalgası eski "kritik" olayları listeden düşürebilir ve
 * ekran bunu söylemezse operatör "olay yok" diye YANLIŞ bilgi alır (destek/bildirim ekranlarında
 * bu dürüstlük bandı zaten var).
 */
export const SECURITY_FETCH_LIMIT = 500;

export interface SecurityEventsData {
  rows: SecurityEventRow[];
  /** Sınıra dayanıldı → daha eski olaylar bu listede YOK (sessiz kırpma olmasın). */
  truncated: boolean;
}

/**
 * Güvenlik olaylarını getirir. type verilirse sunucu filtreler; yoksa hepsi (createdAt DESC).
 * API yanıtı {items:[]} veya doğrudan dizi olabilir → ikisini de normalize eder.
 */
export async function getSecurityEvents(type?: string): Promise<SecurityEventsData> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : '';
  const data = await apiGet<{ items: SecurityEventRow[] } | SecurityEventRow[]>(
    `/v1/admin/security-events${qs}`,
  );
  const rows = Array.isArray(data) ? data : (data?.items ?? []);
  return { rows, truncated: rows.length >= SECURITY_FETCH_LIMIT };
}
