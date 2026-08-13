import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Tedarikçi değişim fişlerinin veri katmanı (salt-okunur).
 *
 * SAVUNMACI TİPLER: api/admin dağıtımları arasında sapma olabilir (yeni alan önce backend'e
 * düşer) → tüm alanlar opsiyonel okunur, ekran `?? null` ile çalışır. Aynı gerekçe
 * `quarantine/queries.ts`'te de yazılı.
 */

export interface ClaimRow {
  id: string;
  code: string;
  /** 'draft' | 'sent' | 'closed' | 'canceled' */
  status: string;
  supplierId: string | null;
  supplierName: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  itemCount: number;
  note: string | null;
  reference: string | null;
  createdBy: string;
  createdAt: string;
  sentAt: string | null;
  closedAt: string | null;
  pendingCount: number;
  replacedCount: number;
  creditedCount: number;
  rejectedCount: number;
  /**
   * Kalem anlık görüntülerinin EN AZ BİRİ maskeli mi (`••••••1234`).
   *
   * İki yoldan olabilir: (a) fişi KESEN kişi owner değildi → snapshot maskeli DONDU ve
   * sonradan owner açsa da maskeli kalır; (b) fişi OKUYAN owner değil → yanıt maskeli döner.
   * Her iki durumda indirilen rapor tedarikçiye işe yaramaz bir liste olarak gider →
   * ekranda uyarılır. Eski API sürümü bu alanı döndürmez (savunmacı: `=== true` kontrolü).
   */
  masked?: boolean;
}

export interface ClaimItemRow {
  id: string;
  licenseItemId: string;
  productId: string | null;
  batchId: string | null;
  batchLabel: string | null;
  productName: string | null;
  sku: string | null;
  /**
   * Fiş anındaki ürün tipi ('key' | 'account' | 'code' | 'custom'). 0034 öncesi kesilen
   * fişlerde ürün silinmişse null kalabilir → ekran nötr "kalem" diline düşer.
   */
  productKind: string | null;
  keySnapshot: string | null;
  reason: string | null;
  defectKind: string | null;
  quarantinedAt: string | null;
  /** 'pending' | 'replaced' | 'credited' | 'rejected' */
  outcome: string;
  outcomeNote: string | null;
  resolvedAt: string | null;
}

export interface ClaimsData {
  rows: ClaimRow[];
  error: string | null;
}

/** Fiş listesi (en yeni önce). Hata ekranı çökertmez — banner olarak gösterilir. */
export async function fetchClaims(): Promise<ClaimsData> {
  try {
    const raw = await apiGet<ClaimRow[] | { rows?: unknown }>('/v1/admin/supplier-claims');
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : [];
    return { rows: list as ClaimRow[], error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : 'Bağlantı hatası' };
  }
}

/** Tek fiş + kalemleri (detay ekranı). 404'te null döner → sayfa notFound(). */
export async function fetchClaim(
  id: string,
): Promise<{ claim: ClaimRow; items: ClaimItemRow[] } | null> {
  try {
    return await apiGet<{ claim: ClaimRow; items: ClaimItemRow[] }>(
      `/v1/admin/supplier-claims/${id}`,
    );
  } catch {
    return null;
  }
}

/** Tedarikçi seçici için (fiş kesme sihirbazı). Pasif tedarikçiler de listelenir (geçmiş fiş). */
export async function fetchSuppliersLite(): Promise<Array<{ id: string; name: string }>> {
  try {
    const raw = await apiGet<Array<{ id: string; name: string; active?: boolean }>>(
      '/v1/admin/suppliers',
    );
    return (Array.isArray(raw) ? raw : []).map((s) => ({ id: s.id, name: s.name }));
  } catch {
    return [];
  }
}
