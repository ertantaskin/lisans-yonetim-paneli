import 'server-only';
import { apiGet } from '../../lib/api';

/** Talep durumu (§13) — `supportStatusLabel` ile Türkçeleştirilir, ham değer UI'a çıkmaz. */
export type SupportStatus = 'open' | 'info_requested' | 'approved' | 'rejected';

/** Yazışmadaki son mesajın yazar tipi (iç not da 'admin' sayılır). */
export type ThreadAuthorType = 'admin' | 'customer' | 'system';

/**
 * Değişim/destek talebi satırı (GET /v1/admin/replacements → `{ items: AdminReplacementRow[] }`).
 *
 * Yazışma + suistimal özeti API'de TEK sorguda (LATERAL + gruplu alt sorgu) hesaplanır — burada
 * ek istek YOK. Bu alanlar kuyruğu "işlenebilir" yapar:
 *  - `unansweredByAdmin`: müşteri yazdı, adminin MÜŞTERİYE GÖRÜNEN yanıtı yok (iç not sayılmaz).
 *  - `customerRequestCount90d`: aynı e-postadan 90 günlük talep sayısı — yalnız İŞARET,
 *    otomatik yaptırım YOK (§15 "AI/sistem önerir, insan onaylar").
 */
export interface ReplacementRow {
  id: string;
  siteId: string;
  orderId: string;
  /** Mağaza (satış kanalı) sipariş no'su — sipariş silinmiş/eşleşmemişse null. */
  remoteOrderId: string | null;
  lineId: string | null;
  assignmentId: string | null;
  customerEmail: string;
  reason: string;
  status: SupportStatus;
  withinWarranty: boolean;
  resolutionNote: string | null;
  createdAt: string;
  /** Yazışmadaki toplam mesaj sayısı (iç notlar DAHİL — admin görünümü). */
  messageCount: number;
  lastMessageAt: string | null;
  lastMessageAuthorType: ThreadAuthorType | null;
  unansweredByAdmin: boolean;
  customerRequestCount90d: number;
}

/**
 * Ham API satırı. Alanlar opsiyoneldir: api ve admin ayrı imajlar olarak dağıtılır
 * (deploy sapması) → eski API yeni alanları döndürmezse ekran ÇÖKMEZ, güvenli
 * varsayılana düşer (mesaj yok / yanıt bekleyen değil / suistimal sayacı 0).
 */
type RawReplacementRow = Partial<Omit<ReplacementRow, 'id'>> & { id: string };

const STATUSES: readonly SupportStatus[] = ['open', 'info_requested', 'approved', 'rejected'];
const AUTHOR_TYPES: readonly ThreadAuthorType[] = ['admin', 'customer', 'system'];

function toStatus(raw: unknown): SupportStatus {
  return STATUSES.includes(raw as SupportStatus) ? (raw as SupportStatus) : 'open';
}

function toAuthorType(raw: unknown): ThreadAuthorType | null {
  return AUTHOR_TYPES.includes(raw as ThreadAuthorType) ? (raw as ThreadAuthorType) : null;
}

function toCount(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function normalize(r: RawReplacementRow): ReplacementRow {
  return {
    id: r.id,
    siteId: r.siteId ?? '',
    orderId: r.orderId ?? '',
    remoteOrderId: r.remoteOrderId ?? null,
    lineId: r.lineId ?? null,
    assignmentId: r.assignmentId ?? null,
    customerEmail: r.customerEmail ?? '',
    reason: r.reason ?? '',
    status: toStatus(r.status),
    withinWarranty: r.withinWarranty === true,
    resolutionNote: r.resolutionNote ?? null,
    createdAt: r.createdAt ?? new Date(0).toISOString(),
    messageCount: toCount(r.messageCount),
    lastMessageAt: r.lastMessageAt ?? null,
    lastMessageAuthorType: toAuthorType(r.lastMessageAuthorType),
    unansweredByAdmin: r.unansweredByAdmin === true,
    customerRequestCount90d: toCount(r.customerRequestCount90d),
  };
}

/**
 * Değişim/destek taleplerini getirir. `status` verilirse sunucu filtreler; yoksa hepsi
 * (API `created_at DESC`, LIMIT 200). Öncelik sıralaması (yanıt bekleyen → açık → bilgi
 * bekleyen → kapanmış) SUNUM katmanında yapılır (components/support-table.tsx).
 */
export async function getReplacements(status?: string): Promise<ReplacementRow[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await apiGet<RawReplacementRow[] | { items: RawReplacementRow[] }>(
    `/v1/admin/replacements${qs}`,
  );
  const rows = Array.isArray(data) ? data : (data?.items ?? []);
  return rows.filter((r) => r && typeof r.id === 'string').map(normalize);
}
