import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Dead-letter satırı (GET /v1/admin/ops/dead-letter yanıtı). Başarısız geri-kanal
 * webhook (outbox) + başarısız/bounce mail (email) + askıda kalmış kayıtlar.
 * Sır/payload İÇERMEZ — yalnız meta.
 *
 * ALAN ADLARI api `OpsService.deadLetterPage()` dönüşüyle BİREBİRDİR (apps/api/src/ops/
 * ops.service.ts). `apiGet<T>` bir DOĞRULAMA yapmaz, yalnız cast'tir — bu yüzden aşağıdaki
 * normalize adımı alanları tek tek okur ve eksikse güvenli varsayılana düşer.
 */
export interface DeadLetterRow {
  kind: 'outbox' | 'email';
  id: string;
  /** outbox: event_type · email: konu (sır değil). */
  label: string;
  status: string;
  error: string | null;
  attempts: number | null;
  orderId: string | null;
  toEmail: string | null;
  createdAt: string;
  updatedAt: string;
  /** Kaydın yaşı (saniye) — askıda kalma süresi görünür olsun. */
  ageSeconds: number;
  /** true → başarısız DEĞİL, askıda kalmış (pending/queued 15dk+). */
  stale: boolean;
  /** false → yeniden kuyruğa ALINAMAZ; UI 'Yeniden gönder' aksiyonunu kapatmalı. */
  replayable: boolean;
  /** replayable=false ise insan-okur gerekçe; aksi halde null. */
  replayBlockedReason: string | null;
}

/**
 * Liste + KAPSAM bilgisi. API satır sınırı uygular; kırpılma SESSİZ kalırsa operatör
 * "hepsi bu kadarmış" sanır ve görünmeyen kayıtlar replay edilmeden kalır (§16).
 */
export interface DeadLetterPage {
  items: DeadLetterRow[];
  /** Koşullara uyan TOPLAM kayıt (sınır uygulanmadan). */
  total: number;
  /** true → total > limit; ekranda "N kayıttan M'i gösteriliyor" uyarısı basılır. */
  truncated: boolean;
  /** API'nin uyguladığı satır sınırı. */
  limit: number;
}

/** Bilinmeyen gövdeden güvenli satır üretir (alan adı sapması/eski API'ye dayanıklı). */
function toRow(raw: unknown): DeadLetterRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const kind = r.kind === 'email' ? 'email' : 'outbox';
  const blocked = typeof r.replayBlockedReason === 'string' ? r.replayBlockedReason : null;
  return {
    kind,
    id: r.id,
    label: typeof r.label === 'string' ? r.label : '—',
    status: typeof r.status === 'string' ? r.status : 'unknown',
    error: typeof r.error === 'string' ? r.error : null,
    attempts: typeof r.attempts === 'number' ? r.attempts : null,
    orderId: typeof r.orderId === 'string' ? r.orderId : null,
    toEmail: typeof r.toEmail === 'string' ? r.toEmail : null,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(0).toISOString(),
    ageSeconds: typeof r.ageSeconds === 'number' ? r.ageSeconds : 0,
    stale: r.stale === true,
    // Alan YOKSA (admin, API'den önce dağıtıldıysa) eski davranış korunur: buton açık kalır.
    // Bu GÜVENLİK açığı DEĞİL — asıl kapı sunucudadır (replay ucu uygun olmayan kaydı açık
    // mesajla reddeder); bayrak yalnız operatörü boşuna denemekten kurtarır.
    replayable: r.replayable === undefined ? true : r.replayable !== false,
    replayBlockedReason: blocked,
  };
}

/**
 * Başarısız outbox + mail kayıtlarını getirir (updatedAt DESC, API satır sınırlı).
 *
 * Yanıt kanonik olarak `{ items, total, truncated, limit }`'tir; dizi gövdesi yalnız
 * eski API dağıtımına karşı geriye dönük tolerans için kabul edilir.
 */
export async function getDeadLetter(): Promise<DeadLetterPage> {
  const data = await apiGet<unknown>('/v1/admin/ops/dead-letter');

  const rawItems: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { items?: unknown } | null)?.items)
      ? ((data as { items: unknown[] }).items)
      : [];

  const items = rawItems.map(toRow).filter((r): r is DeadLetterRow => r !== null);

  const meta = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const total = typeof meta.total === 'number' ? meta.total : items.length;
  const limit = typeof meta.limit === 'number' ? meta.limit : items.length;
  // `truncated` API'den gelirse ona güven; gelmiyorsa toplam/satır farkından türet.
  const truncated = typeof meta.truncated === 'boolean' ? meta.truncated : total > items.length;

  return { items, total, truncated, limit };
}
