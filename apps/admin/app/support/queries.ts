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
  /**
   * Talebin geldiği mağazanın alan adı (API sites JOIN'i). Çok siteli kurulumda mağaza sipariş
   * no'ları ÇAKIŞIR — karar bu bağlam olmadan verilemez. Eski API sürümünde gelmezse null.
   */
  siteDomain: string | null;
  orderId: string;
  /** Mağaza (satış kanalı) sipariş no'su — sipariş silinmiş/eşleşmemişse null. */
  remoteOrderId: string | null;
  lineId: string | null;
  assignmentId: string | null;
  /** İlgili panel ürünü (satırdan/atamadan çözülür) — "Onayla" bu üründen stok ister. */
  productId: string | null;
  productName: string | null;
  /** Ürünün kullanım modu — MAK/multi üründe değişim akışı reddedilir (düğme kapatılır). */
  usageMode?: string | null;
  productSku: string | null;
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
    siteDomain: r.siteDomain ?? null,
    orderId: r.orderId ?? '',
    remoteOrderId: r.remoteOrderId ?? null,
    lineId: r.lineId ?? null,
    assignmentId: r.assignmentId ?? null,
    // Ürün alanları eski API'de YOK → uydurma değer basma; ekran '—' gösterir.
    productId: r.productId ?? null,
    productName: r.productName ?? null,
    usageMode: r.usageMode ?? null,
    productSku: r.productSku ?? null,
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
 * API tarafındaki SABİT üst sınır (`replacements.service.list` → `LIMIT 200`). Sunucu
 * sayfalama sunmadığı için istemci bu sınırı BİLMEK zorunda: sınıra dayanan liste kırpılmıştır
 * ve bunu söylemeden göstermek yanlış bilgi olur ("açık talep yok" derken vardır).
 */
export const SUPPORT_FETCH_LIMIT = 200;

/** İşlenmesi gereken (kuyrukta duran) durumlar — kapanmış talepler bunları listeden DÜŞÜREMEZ. */
const QUEUE_STATUSES: readonly SupportStatus[] = ['open', 'info_requested'];

/** Tek kova: verilen statüde (ya da statüsüz) API çağrısı + normalize. */
async function fetchBucket(status?: string): Promise<ReplacementRow[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await apiGet<RawReplacementRow[] | { items: RawReplacementRow[] }>(
    `/v1/admin/replacements${qs}`,
  );
  const rows = Array.isArray(data) ? data : (data?.items ?? []);
  return rows.filter((r) => r && typeof r.id === 'string').map(normalize);
}

/** Destek kuyruğu verisi + kırpma dürüstlüğü (sessiz kırpma yok). */
export interface SupportQueueData {
  rows: ReplacementRow[];
  /** AÇIK/bilgi bekleyen kova üst sınıra dayandı → gerçekten eksik AÇIK talep var (ciddi). */
  openTruncated: boolean;
  /** Statüsüz (geçmiş) kova üst sınıra dayandı → yalnız ESKİ KAPANMIŞ talepler eksik. */
  historyTruncated: boolean;
  /** Statü kovaları çekilemedi (API hatası) → liste yalnız son 200 kayıttan ibaret. */
  scopeDegraded: boolean;
  /**
   * Ekranda gösterilecek HAZIR uyarı cümlesi (null = uyarı yok). Bant tek satırla bağlanır:
   * `{data.notice && <Alert variant="warning">…{data.notice}…</Alert>}`
   */
  notice: string | null;
}

/**
 * Destek kuyruğunu getirir — KAPSAM SUNUCUDA DARALTILIR.
 *
 * Sorun (denetim bulgusu): tek `GET /v1/admin/replacements` çağrısı `created_at DESC LIMIT 200`
 * döndürür. Talep hacmi 200'ü aşınca ESKİ ama HÂLÂ AÇIK talepler listeden düşüyordu; ekran bunu
 * söylemediği için sayaçlar "açık talep yok" diye YANLIŞ bilgi veriyordu.
 *
 * Çözüm: açık ve bilgi-bekleyen talepler AYRI statü sorgularıyla (her biri kendi 200'lük
 * penceresiyle) çekilir → kapanmış talep hacmi kuyruğu artık bastıramaz. Statüsüz sorgu ise
 * "son kapanmış talepler" bağlamını korur. Üç kova id bazında birleştirilir.
 *
 * Dayanıklılık: statüsüz sorgu hata verirse (mevcut davranış) HATA YÜKSELİR — sayfa kendi hata
 * bandını gösterir. Statü kovaları best-effort'tur; biri düşerse ekran kapanmaz ama `notice` ile
 * kapsamın daraldığı DÜRÜSTÇE bildirilir.
 */
export async function getSupportQueue(): Promise<SupportQueueData> {
  const [history, buckets] = await Promise.all([
    // Statüsüz kova: mevcut davranış — hata YÜKSELİR, sayfa kendi hata bandını gösterir.
    fetchBucket(),
    // Statü kovaları: best-effort (biri düşerse ekran kapanmaz, `scopeDegraded` ile bildirilir).
    Promise.all(QUEUE_STATUSES.map((s) => fetchBucket(s).catch(() => null))),
  ]);

  const scopeDegraded = buckets.some((b) => b === null);
  const openTruncated = buckets.some((b) => (b?.length ?? 0) >= SUPPORT_FETCH_LIMIT);
  const historyTruncated = history.length >= SUPPORT_FETCH_LIMIT;

  // id bazında birleştir (kovalar kesişir — aynı talep hem statüsüz hem statülü sorguda gelir).
  const byId = new Map<string, ReplacementRow>();
  for (const row of [...history, ...buckets.flatMap((b) => b ?? [])]) byId.set(row.id, row);
  const rows = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  let notice: string | null = null;
  if (openTruncated) {
    notice = `Açık talep sayısı listeleme sınırına (${SUPPORT_FETCH_LIMIT}) ulaştı — en eski açık talepler bu listede görünmüyor olabilir. Durum süzgeciyle daraltın ve talepleri kapatarak kuyruğu eritin.`;
  } else if (scopeDegraded) {
    notice = `Açık talepler ayrıca sorgulanamadı; liste yalnız son ${SUPPORT_FETCH_LIMIT} kaydı gösteriyor — daha eski açık talepler eksik olabilir. Sayfayı yenileyin.`;
  } else if (historyTruncated) {
    notice = `Geçmiş listesi ${SUPPORT_FETCH_LIMIT} kayıtla sınırlı — açık ve bilgi bekleyen talepler eksiksiz, yalnız eski KAPANMIŞ talepler görünmüyor.`;
  }

  return { rows, openTruncated, historyTruncated, scopeDegraded, notice };
}

/**
 * Değişim/destek taleplerini getirir. `status` verilirse sunucu filtreler; yoksa kuyruk
 * kapsamı `getSupportQueue()` ile daraltılmış olarak döner (açık talepler kırpılmaz).
 * Öncelik sıralaması (yanıt bekleyen → açık → bilgi bekleyen → kapanmış) SUNUM katmanında
 * yapılır (components/support-table.tsx).
 *
 * NOT: kırpma uyarısını GÖSTERMEK için `getSupportQueue()` kullanılmalıdır — bu sarmalayıcı
 * yalnız satırları döndürdüğü için uyarı bilgisi taşıyamaz (mevcut çağrı yerleri kırılmasın diye
 * imza korundu).
 */
export async function getReplacements(status?: string): Promise<ReplacementRow[]> {
  // Statü verildiyse sunucu zaten daraltıyor (geçersiz statüde API boş liste döner) — tek çağrı.
  if (status) return fetchBucket(status);
  const { rows } = await getSupportQueue();
  return rows;
}
