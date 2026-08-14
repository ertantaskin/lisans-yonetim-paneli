'use server';
import { apiRaw } from '../../lib/api';
import { getActor } from '../../lib/session';
import { AUDIT_ACTIONS, AUDIT_PAGE_SIZES, DEFAULT_AUDIT_PAGE_SIZE } from './constants';

/**
 * Denetim izi sunucu aksiyonu (§8).
 *
 * NEDEN ACTION: liste İSTEMCİDE etkileşimli (süzgeç/sayfalama) ama ADMIN_TOKEN tarayıcıya
 * ASLA gitmez → istemci bu action'ı çağırır, action Next sunucusunda API'ye gider.
 * Sayfalama SUNUCUDA (LIMIT/OFFSET): 100 satır seçilse bile istemciye yalnız o sayfa iner.
 *
 * KRİTİK (Next 15): bu dosya YALNIZ async fonksiyon export edebilir — sabitler `constants.ts`
 * içinde, tip export'ları derlemede silinir (sorunsuz).
 *
 * SALT-OKUNUR: denetim izine yazma/silme aksiyonu YOKTUR ve eklenmemelidir (append-only).
 */

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  targetType: string | null;
  targetId: string | null;
  /** API tarafında sır çağrıştıran anahtarlar `[gizlendi]` ile değiştirilmiş jsonb. */
  meta: unknown;
  traceId: string | null;
  createdAt: string;
}

export interface AuditPageData {
  items: AuditEntry[];
  /** Süzgece uyan kayıt sayısı; `totalCapped` true ise "en az bu kadar" demektir. */
  total: number;
  totalCapped: boolean;
  page: number;
  pageSize: number;
  countCap: number;
}

export interface AuditListParams {
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  traceId?: string;
  /** Yerel (naive) ISO damgası — API `new Date()` ile sunucu saat diliminde yorumlar. */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export type AuditListResult =
  | { ok: true; page: AuditPageData }
  | { ok: false; error: string };

/** Non-2xx yanıttan kullanıcıya gösterilecek Türkçe mesajı çıkarır (ham gövde sızmaz). */
async function messageOf(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { message?: unknown };
    const m = data?.message;
    if (typeof m === 'string' && m.trim()) return m;
    if (Array.isArray(m)) {
      const joined = m.filter((x): x is string => typeof x === 'string').join('; ');
      if (joined) return joined;
    }
  } catch {
    /* gövde JSON değil → fallback */
  }
  return fallback;
}

/**
 * Denetim kaydı sayfası. Tüm parametreler BURADA da doğrulanır/kırpılır → geçersiz istemci
 * girdisi API'ye hiç gitmez (API yine de kendi kapısını korur; iki katman bilinçli).
 */
export async function fetchAuditAction(params: AuditListParams = {}): Promise<AuditListResult> {
  const qs = new URLSearchParams();

  const actor = String(params.actor ?? '').trim().slice(0, 200);
  if (actor) qs.set('actor', actor);

  // UI'da seçilebilen değer API'de 400 almasın: liste `constants.ts` ile TEK KAYNAK.
  if (params.action && (AUDIT_ACTIONS as readonly string[]).includes(params.action)) {
    qs.set('action', params.action);
  }
  // targetType uygulama tarafından üretilir (küçük harf + alt çizgi); kalıba uymayan değer
  // API'de 400 olurdu → burada süzülür.
  const targetType = String(params.targetType ?? '').trim();
  if (/^[a-z_]{1,64}$/.test(targetType)) qs.set('targetType', targetType);

  const targetId = String(params.targetId ?? '').trim().slice(0, 200);
  if (targetId) qs.set('targetId', targetId);

  const traceId = String(params.traceId ?? '').trim().slice(0, 200);
  if (traceId) qs.set('traceId', traceId);

  // Tarih: yalnız ayrıştırılabilir değer gönderilir (yarım yazılmış `<input type=date>`
  // değeri API'de 400 üretirdi ve operatör yazarken ekran kırmızıya dönerdi).
  const from = String(params.from ?? '').trim();
  if (from && !Number.isNaN(Date.parse(from))) qs.set('from', from);
  const to = String(params.to ?? '').trim();
  if (to && !Number.isNaN(Date.parse(to))) qs.set('to', to);

  const rawPage = Number(params.page);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(Math.floor(rawPage), 9_999_999) : 1;
  qs.set('page', String(page));

  const rawSize = Number(params.pageSize);
  qs.set(
    'pageSize',
    String(
      (AUDIT_PAGE_SIZES as readonly number[]).includes(rawSize) ? rawSize : DEFAULT_AUDIT_PAGE_SIZE,
    ),
  );

  try {
    const res = await apiRaw('GET', `/v1/admin/audit?${qs.toString()}`, { actor: await getActor() });
    if (!res.ok) return { ok: false, error: await messageOf(res, 'Denetim kayıtları alınamadı.') };
    const data = (await res.json()) as AuditPageData;
    return { ok: true, page: data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Bağlantı hatası' };
  }
}
