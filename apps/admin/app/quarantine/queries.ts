import { apiGet, type QuarantineRow } from '../../lib/api';

/**
 * Karantina ekranının veri katmanı (salt-okunur).
 *
 * SÜZME İKİ KATMANLI (bilinçli):
 *  1. **Sunucu süzgeci** (URL arama parametresi → `GET /v1/admin/quarantine`): durum, tarih
 *     aralığı ve arama metni. Bunlar veritabanı sorgusunda uygulanır — sorgu TÜM kayıtları
 *     tarar, ama SONUÇ yine en fazla `QUARANTINE_LIMIT` kayıttır (kırpılırsa `truncated`).
 *     Değişince sayfa sunucuda yeniden render edilir.
 *  2. **Yerel (hızlı) süzgeç** (tablo bileşeninde): ürün/tedarikçi/site facet'leri + anlık
 *     arama. YALNIZ yüklenen pencere içinde, istek atmadan süzer.
 *
 * Neden yerel katman da var: bu ekranın ana işi "listeyi tedarikçiye ilet" — operatör süzer,
 * sonra ya GÖRÜNEN satırları ya da YÜKLENEN tümünü dışa aktarır (CSV veya düz metin). "Tümü"
 * seçeneği ancak kayıtlar tarayıcıda hazırsa dürüst olur (ADMIN_TOKEN tarayıcıya gitmez →
 * istemciden yeniden sorgulanamaz).
 *
 * Neden sunucu katmanı ŞART (denetim bulgusu): tek pencere 5000 kayıtla sınırlı; 12.000 kayıtlı
 * bir kurulumda tarih/durum süzgeci yalnız istemcide çalışsaydı eski kayıtlar "yok" görünürdü ve
 * kırpılma uyarısının önerdiği "aralığı daraltıp yeniden yükleyin" eylemi UYGULANAMAZ olurdu.
 *
 * TARİH SÜZGECİNİN İNCE NOKTASI (G6): karantina tarihi tek bir DB kolonu değil (değişim geçmişi /
 * revoke audit'i / stok düzeltme / atama / stok girişi koalesansı). Sunucu bu yüzden SQL'de
 * "kesin aralığı KAPSAYAN" bir ön-filtre uygular (pencere doğru döneme kayar) ve kesin süzmeyi
 * kayıtları birleştirdikten sonra yapar. Sonuç operatör açısından tektir: seçilen dönem sunucuda
 * süzülür; pencereye sığmazsa `truncated` ile UYARILIR (sessiz eksik liste YOK).
 *
 * NOT: tablo bileşeni DataTable'ın KENDİ iç filtresini kullanmaz, yerel süzgeçleri kendi tutar.
 * Sebep: dışa aktarmadaki "görünen N kayıt" sayısının dürüst olması için süzülmüş kümenin TEK
 * doğruluk kaynağı olması gerekir (DataTable iç filtre durumunu dışarı vermez).
 */

/**
 * Backend üst sınırı (`listQuarantine`: 1..5000). Tek yerden okunur.
 *
 * Ekrana da PROP olarak geçilir (`page.tsx` → `QuarantineTable limit=`): "liste kırpılmış
 * olabilir" uyarısı ve "Tümü" dışa aktarmasının kapsamı bu sayıyla anlatılır. İstemci bu
 * modülden İÇE AKTARAMAZ — `lib/api` `server-only`'dir, buradan yalnız `import type` yapılır.
 */
export const QUARANTINE_LIMIT = 5000;

/** Sunucunun kabul ettiği durum süzgeci ('' = tümü). */
export type QuarantineStatusFilter = '' | 'quarantined' | 'voided';
/** Tarih aralığı ön ayarı — YALNIZ arayüz durumu (hangi düğme aktif); süzme `from`/`to` ile yapılır. */
export type QuarantineRange = '' | '7' | '30' | '90' | 'custom';

/**
 * Bildirim durumu süzgeci — `GET /v1/admin/quarantine?claimed=`.
 * 'none' = açık fişte kaydı olmayan (= BİLDİRİLECEKLER havuzu), 'open' = fişte yanıt bekleyen,
 * 'any' = süzme yok (API'de de `undefined`'a düşer).
 */
export type QuarantineClaimedFilter = 'none' | 'open' | 'any';

/** Sunucuya giden (ve ekranda gösterilen) doğrulanmış süzgeç kümesi. */
export interface QuarantineFilterState {
  status: QuarantineStatusFilter;
  range: QuarantineRange;
  /** YYYY-MM-DD (gün başlangıcı). */
  from: string;
  /** YYYY-MM-DD — sunucu gün SONUNA kadar kapsar. */
  to: string;
  /** Ürün adı/SKU, müşteri e-postası, sipariş no, parti etiketi, tedarikçi adı (sunucuda ILIKE). */
  search: string;
  /**
   * SAYFA-İÇİ SABİT — URL'den OKUNMAZ (`parseQuarantineFilters` bunu ASLA doldurmaz).
   *
   * "Bildirilecekler" sayfası `'none'` geçer, "Tüm Kayıtlar" hiç geçmez. Havuz eskiden defterin
   * JS süzgeciydi (`rows.filter(r => !r.claimId)`) → defter 5000'lik sunucu tavanına dayandığında
   * havuz da SESSİZCE eksiliyordu. Artık aynı yüklem SUNUCUDA uygulanır (API `claimed` süzgeci):
   * havuz kendi penceresini alır ve kendi `truncated` uyarısını taşır.
   */
  claimed?: QuarantineClaimedFilter;
}

export const EMPTY_QUARANTINE_FILTERS: QuarantineFilterState = {
  status: '',
  range: '',
  from: '',
  to: '',
  search: '',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `?a=1&a=2` → ilk değer; boşluklar kırpılır. */
const one = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();

/**
 * URL arama parametrelerini süzgeç durumuna çevirir.
 *
 * SAVUNMACI: parametreler kullanıcı tarafından elle yazılabilir. Geçersiz değer sunucuya
 * GÖNDERİLMEZ (API'nin Zod doğrulaması 400 döndürüp ekranın TAMAMINI hata kutusuna
 * düşürürdü) — sessizce "süzgeç yok" kabul edilir.
 */
export function parseQuarantineFilters(
  sp: Record<string, string | string[] | undefined> = {},
): QuarantineFilterState {
  const status = one(sp.status);
  const range = one(sp.range);
  const from = one(sp.from);
  const to = one(sp.to);
  return {
    status: status === 'quarantined' || status === 'voided' ? status : '',
    range: range === '7' || range === '30' || range === '90' || range === 'custom' ? range : '',
    from: DATE_RE.test(from) ? from : '',
    to: DATE_RE.test(to) ? to : '',
    // API `search` alanını 200 karakterle sınırlar — burada da kırpılır (400 yerine süzgeç çalışsın).
    search: one(sp.q).slice(0, 200),
  };
}

/**
 * Herhangi bir SUNUCU süzgeci etkin mi (yerel facet'ler sayılmaz).
 *
 * `claimed` BİLEREK sayılmaz: o operatörün seçtiği bir süzgeç değil, bulunduğu bölümün tanımıdır
 * ("Bildirilecekler" zaten `claimed=none` demektir) — saysaydık havuz sayfası her açılışta
 * "bir süzgeç etkin" uyarısı gösterirdi.
 */
export function hasQuarantineServerFilters(f: QuarantineFilterState): boolean {
  return Boolean(f.status || f.from || f.to || f.search);
}

/**
 * Karantina satırı — `GET /v1/admin/quarantine` kaydı.
 *
 * SAVUNMACI TİP: api/admin dağıtımları arasında sapma olabileceği için (yeni alanlar önce
 * backend'e düşer) tüm alanlar opsiyoneldir; yalnız `licenseItemId` (React anahtarı) zorunlu
 * kabul edilir. Ekran her alanı `?? null` ile okur → eski API'ye karşı da ÇÖKMEZ.
 */
export type QuarantineItem = Partial<QuarantineRow> & { licenseItemId: string };

export interface QuarantineData {
  rows: QuarantineItem[];
  error: string | null;
  /** Üst sınıra dayanıldı → liste kırpılmış olabilir (dışa aktarma eksik kalabilir). */
  truncated: boolean;
}

/**
 * API yanıtı: yeni biçim `{ rows, truncated, limit }`. Dizi biçimi ESKİ api dağıtımıdır
 * (admin/api sürüm sapması) — geriye dönük okunur.
 */
type QuarantineResponse =
  QuarantineItem[] | { rows?: unknown; truncated?: unknown; limit?: unknown };

/**
 * Listeyi çeker. Süzgeçler API'ye AYNEN geçirilir (durum/tarih/arama sunucuda uygulanır);
 * boş alanlar hiç gönderilmez → parametresiz çağrı eski davranışı korur.
 */
export async function fetchQuarantine(
  filters: QuarantineFilterState = EMPTY_QUARANTINE_FILTERS,
): Promise<QuarantineData> {
  const params = new URLSearchParams({ limit: String(QUARANTINE_LIMIT) });
  if (filters.status) params.set('status', filters.status);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.search) params.set('search', filters.search);
  // 'any' = süzme yok → hiç gönderilmez (API'de de `undefined`'a düşüyor; parametresiz çağrı
  // eski davranışı korur).
  if (filters.claimed && filters.claimed !== 'any') params.set('claimed', filters.claimed);

  try {
    const raw = await apiGet<QuarantineResponse>(`/v1/admin/quarantine?${params.toString()}`);
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : [];
    // Beklenmeyen gövde (ör. proxy hata sayfası) tabloyu çökertmesin.
    const rows = (list as QuarantineItem[]).filter((r) => r && typeof r.licenseItemId === 'string');
    // KIRPILMA: yeni API bunu KENDİ hesaplar (ham SQL satır sayısı üst sınıra dayandı mı) —
    // döndürülen satır sayısına bakmak YANILTICIYDI: tarih süzgeci satırları kırptığında liste
    // eksikken uyarı `false` çıkıyordu (G6). Eski (dizi) API'de tek elde edilebilen sinyal
    // satır sayısıdır → yalnız orada ona düşülür.
    const truncated = Array.isArray(raw)
      ? rows.length >= QUARANTINE_LIMIT
      : raw?.truncated === true;
    return { rows, error: null, truncated };
  } catch (e) {
    return {
      rows: [],
      error: e instanceof Error ? e.message : 'Bağlantı hatası',
      truncated: false,
    };
  }
}
