import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * İnceleme kuyruğu satırı (GET /v1/admin/review yanıtı, §8 held_for_review).
 * Dinamik satış kotası eşiğini aşan siparişler reddedilmez, manuel onay için
 * tutulur (held). remoteOrderId / siteDomain API tarafında JOIN ile getirilir.
 */
export interface ReviewRow {
  id: string;
  remoteOrderId: string;
  customerEmail: string;
  status: string;
  heldAt: string | null;
  heldReason: string | null;
  createdAt: string;
  siteId: string;
  siteDomain: string | null;
  lineCount: number;
}

/**
 * İnceleme kuyruğu verisi + KIRPMA DÜRÜSTLÜĞÜ.
 *
 * Neden gerekli: `GET /v1/admin/review` sunucuda sabit bir üst sınırla (LIMIT) döner ve sayfa
 * bunu söylemiyordu → kuyruk sınıra dayandığında en ESKİ bekleyen siparişler listeden sessizce
 * düşüyor, operatör "inceleme kuyruğu bu kadarmış" sanıyordu. Bu, panelin defalarca yaşadığı
 * "sessiz kırpma" sınıfı hatanın aynısıdır (bkz. /support kuyruğu, karantina havuzu).
 */
export interface ReviewQueueData {
  rows: ReviewRow[];
  /** Sunucu penceresine dayanıldı → liste eksik olabilir. */
  truncated: boolean;
  /** Sunucunun uyguladığı üst sınır (eski API bildirmiyor → null). */
  limit: number | null;
  /** Ekranda gösterilecek HAZIR uyarı cümlesi (null = uyarı yok). */
  notice: string | null;
}

/**
 * API yanıt biçimleri. YENİ: `{ items, truncated, limit }`. ESKİ: düz dizi (api/admin ayrı
 * imajlar olarak dağıtılır — admin önce güncellenirse eski gövde gelmeye devam eder).
 */
type ReviewResponse = ReviewRow[] | { items?: unknown; truncated?: unknown; limit?: unknown };

/**
 * İnceleme bekleyen (held) siparişleri getirir — her iki yanıt biçimi de güvenle normalize
 * edilir (bilinmeyen gövdede boş liste; ekran ÇÖKMEZ).
 *
 * Eski (dizi) biçimde kırpma bilgisi ÜRETİLEMEZ: sunucunun sınırı bilinmediği için satır
 * sayısından çıkarım yapmak uydurma olurdu → `truncated=false` bırakılır (yanlış uyarı yerine
 * uyarı yok). Sınır API'den gelmeye başlayınca uyarı kendiliğinden doğru çalışır.
 */
export async function getReviewQueue(): Promise<ReviewQueueData> {
  const data = await apiGet<ReviewResponse>('/v1/admin/review');

  const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  // Beklenmeyen gövde (ör. proxy hata sayfası) tabloyu çökertmesin: yalnız id taşıyan satırlar.
  const rows = (list as ReviewRow[]).filter((r) => r && typeof r.id === 'string');

  const rawLimit = Array.isArray(data) ? undefined : Number(data?.limit);
  const limit = Number.isFinite(rawLimit) && (rawLimit as number) > 0 ? Math.trunc(rawLimit as number) : null;
  const truncated = Array.isArray(data) ? false : data?.truncated === true;

  const notice = truncated
    ? `İnceleme kuyruğu listeleme sınırına${limit ? ` (${limit.toLocaleString('tr-TR')} sipariş)` : ''} ulaştı — en eski bekleyen siparişler bu listede GÖRÜNMÜYOR olabilir. Buradaki siparişleri onaylayıp/reddederek kuyruğu eritin; liste kısaldıkça gizli kalanlar görünür hale gelir.`
    : null;

  return { rows, truncated, limit, notice };
}
