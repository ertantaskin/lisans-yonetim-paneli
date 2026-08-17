'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, apiRaw, apiSend } from '../../lib/api';
import { getActor, isOwner } from '../../lib/session';
import { LICENSE_PAGE_SIZES } from '../../lib/license-page-sizes';

/**
 * Lisans envanteri sunucu aksiyonları (§12/§13).
 *
 * Neden action: envanter tablosu İSTEMCİDE etkileşimli (arama/filtre/sayfalama), ama
 * ADMIN_TOKEN tarayıcıya ASLA gitmez → istemci bu action'ları çağırır, action Next
 * sunucusunda API'ye gider. Sayfalama SUNUCU tarafında (LIMIT/OFFSET) — 100 satır seçilse
 * bile istemciye yalnız o sayfa iner.
 *
 * KRİTİK (Next 15): bu dosya YALNIZ async fonksiyon export edebilir. Sabitler (izinli
 * sayfa boyutları vb.) bilerek yerel tutuldu; tip export'ları derlemede silinir (sorunsuz).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** API `optionalDigits` şeması `^\d{1,7}$` bekler → sayfa numarası bu aralığa kırpılır. */
const MAX_PAGE = 9_999_999;
// TEK KAYNAK: lib/license-page-sizes (uc ayri kopya bu partide birlestirildi).
const PAGE_SIZES: readonly number[] = LICENSE_PAGE_SIZES;
const SORTS = ['created_desc', 'created_asc', 'assigned_desc'];
/** UI'da sunulan durum süzgeçleri (license_items enum'unun tamamı değil — operatör dili). */
const STATUSES = [
  'available',
  'assigned',
  'quarantined',
  'voided',
  'expired',
  'suspended',
  'replaced',
  'revoked',
  'depleted',
];

// ── API yanıt tipleri (apps/api stock.service.ts ile birebir; JSON'da tarihler string) ──
export interface LicenseInventoryField {
  key: string;
  label: string;
  value: string;
  /** Şemada "gizli" işaretli alan (parola vb.) — UI varsayılan olarak gizler. */
  secret: boolean;
}

export interface LicenseInventoryDelivery {
  assignmentId: string;
  assignmentStatus: string;
  units: number;
  assignedAt: string | null;
  validUntil: string | null;
  orderId: string;
  remoteOrderId: string;
  customerEmail: string;
  siteId: string;
  siteDomain: string;
  siteType: string;
  /** Mağaza admin panelindeki sipariş bağlantısı — SALT YÖNLENDİRME (otomatik bağlantı YOK). */
  storeAdminUrl: string | null;
}

export interface LicenseInventoryRow {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  /** products.kind ham değeri (key | account | code | custom) — UI labels ile Türkçeleştirir. */
  productType: string;
  usageMode: string;
  status: string;
  maxUses: number;
  useCount: number;
  remainingUses: number;
  kind: 'key' | 'account';
  value: string | null;
  fields: LicenseInventoryField[] | null;
  batchId: string | null;
  batchCode: string | null;
  supplierName: string | null;
  unitCostCents: number | null;
  costCurrency: string | null;
  createdAt: string;
  delivered: LicenseInventoryDelivery | null;
}

export interface LicenseInventoryPage {
  rows: LicenseInventoryRow[];
  /**
   * Süzgece uyan kayıt sayısı. `totalCapped` true ise "EN AZ bu kadar" demektir —
   * UI bunu "10.000+" gibi DÜRÜSTÇE yazmak zorunda (sessiz/yanlış toplam yasak).
   */
  total: number;
  /**
   * Sayım sunucu tavanına dayandı mı? OPSİYONEL: api ve admin ayrı imajlar — eski API bu
   * alanı göndermez, o durumda davranış eskisi gibi ("total = tam sayı") kalır.
   */
  totalCapped?: boolean;
  /** Sayımın kırpıldığı sınır (sunucudan) — UI metni buradan kurulur. */
  countCap?: number;
  page: number;
  pageSize: number;
  /**
   * Değerler MASKELİ mi (A1: düz metin yalnız owner'a)? OPSİYONEL: api ve admin ayrı
   * imajlar — eski API bu alanı göndermez. O durumda istemci satırlardan sezer
   * (`looksMasked`), böylece maskeli dosyaya uyarı basma davranışı kaybolmaz.
   */
  masked?: boolean;
}

/** `GET /v1/admin/license-items/export` yanıtı — sayfalama YOK, sunucu tavanı var. */
export interface LicenseInventoryExport {
  rows: LicenseInventoryRow[];
  /** Süzgece uyan toplam (kırpılmadan önce). `totalCapped` true ise ALT SINIRDIR. */
  total: number;
  /** Sayım sunucu tavanına dayandı mı (bkz. LicenseInventoryPage)? */
  totalCapped?: boolean;
  /** Sayımın kırpıldığı sınır (sunucudan). */
  countCap?: number;
  /** Sunucu üst sınırı. */
  limit: number;
  /** true → dosyada eksik kayıt var; UI bunu GÖRÜNÜR yazmak zorunda (sessiz kırpma yasak). */
  truncated: boolean;
  masked?: boolean;
}

export interface LicenseExportResult {
  ok: boolean;
  data?: LicenseInventoryExport;
  error?: string;
}

export interface LicenseListParams {
  productId?: string;
  siteId?: string;
  batchId?: string;
  status?: string;
  /** 'customer' → yalnız canlı ataması olanlar (müşterinin elindekiler). */
  holder?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface LicenseListResult {
  ok: boolean;
  page?: LicenseInventoryPage;
  error?: string;
}

export interface LicenseMutationResult {
  ok: boolean;
  error?: string;
}

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
 * SÜZGEÇ fragmanı — liste ve dışa aktarma ucu BİREBİR aynısını kullanır.
 *
 * NEDEN TEK YERDE: iki çağıran kendi query'sini kurarsa dosya ile ekrandaki liste sessizce
 * ayrışır (bu projede "toplam ile liste çelişiyor" sınıfı hata daha önce yaşandı). Sayfalama
 * alanları BİLEREK burada değil: dışa aktarmada sayfa kavramı yok.
 */
function filterQuery(params: LicenseListParams): URLSearchParams {
  const qs = new URLSearchParams();
  if (params.productId && UUID_RE.test(params.productId)) qs.set('productId', params.productId);
  if (params.siteId && UUID_RE.test(params.siteId)) qs.set('siteId', params.siteId);
  if (params.batchId && UUID_RE.test(params.batchId)) qs.set('batchId', params.batchId);
  if (params.status && STATUSES.includes(params.status)) qs.set('status', params.status);
  // "Kim tutuyor" ekseni — envanter DURUMUNDAN ayrıdır (MAK anahtarı kısmen satılmışken
  // hâlâ 'available' görünür). Geri çekilmiş partide "hangileri hâlâ müşterilerde" sorusu
  // yalnız bununla cevaplanır.
  if (params.holder === 'customer') qs.set('holder', 'customer');

  const search = String(params.search ?? '').trim().slice(0, 120);
  if (search) qs.set('search', search);

  if (params.sort && SORTS.includes(params.sort)) qs.set('sort', params.sort);
  return qs;
}

/** İşlem sonrası ilgili ekranları tazeler (ürün detayı + /stock stok kolonu). */
function revalidateInventory(productId?: string) {
  if (productId && UUID_RE.test(productId)) revalidatePath(`/products/${productId}`);
  revalidatePath('/stock');
}

/**
 * Lisans envanteri sayfası. Ürün-bazlı (`productId`) veya GLOBAL (parametresiz).
 * Tüm parametreler burada doğrulanır/kırpılır → geçersiz istemci girdisi API'de 400 üretmez.
 * Aktör başlığı taşınır: her liste görüntülemesi API tarafında TEK 'reveal' audit kaydına düşer.
 */
export async function fetchLicenseItemsAction(
  params: LicenseListParams = {},
): Promise<LicenseListResult> {
  const qs = filterQuery(params);

  const rawPage = Number(params.page);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(Math.floor(rawPage), MAX_PAGE) : 1;
  qs.set('page', String(page));

  const rawSize = Number(params.pageSize);
  // Geçersiz/eksik değerde 25'e düşülür — listenin İLK elemanına DEĞİL: liste başına 10
  // eklenince "pageSize gönderilmeyen" tüm çağrılar sessizce 10 satıra düşerdi.
  qs.set('pageSize', String(PAGE_SIZES.includes(rawSize) ? rawSize : 25));

  try {
    const res = await apiRaw('GET', `/v1/admin/license-items?${qs.toString()}`, {
      actor: await getActor(),
    });
    if (!res.ok) return { ok: false, error: await messageOf(res, 'Lisans listesi alınamadı.') };
    const data = (await res.json()) as LicenseInventoryPage;
    return { ok: true, page: data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Bağlantı hatası' };
  }
}

/**
 * Envanteri DIŞA AKTARMAK için TÜM süzgeç sonucunu çeker (mutabakat/muhasebe).
 *
 * NEDEN SUNUCU UCU (istemcide sayfa sayfa toplamak yerine):
 *  · Tavan ve kırpılma bilgisi sunucudan gelir → dosya "eksik mi" sorusunu KESİN yanıtlar
 *    (sayfa döngüsünde son sayfaya kadar bilinmez ve arada veri değişirse mükerrer/eksik olur).
 *  · Düz metin dışa aktarımı TEK 'reveal' audit kaydı bırakır; sayfa döngüsü N kayıt yazardı.
 *  · Rol kapısı (A1) tek noktada: owner değilse yanıt MASKELİ döner, istemcinin yapabileceği
 *    bir şey yok.
 * Tarayıcı belleği: satırlar zaten JSON olarak tek seferde iner ve dosyaya çevrilip bırakılır;
 * tavan (sunucuda 5.000) bunu sınırlar.
 */
export async function exportLicenseItemsAction(
  params: LicenseListParams = {},
): Promise<LicenseExportResult> {
  const qs = filterQuery(params);
  try {
    const res = await apiRaw('GET', `/v1/admin/license-items/export?${qs.toString()}`, {
      actor: await getActor(),
    });
    if (!res.ok) {
      return { ok: false, error: await messageOf(res, 'Dışa aktarma listesi alınamadı.') };
    }
    const data = (await res.json()) as LicenseInventoryExport;
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Bağlantı hatası' };
  }
}

/**
 * Tekil lisansı GEÇERSİZ KIL ("sil"). Kayıt silinmez — izlenebilirlik için `voided`
 * durumuna geçer ve stoktan düşer. Teslim edilmiş lisansta API 409 döner; mesaj AYNEN
 * kullanıcıya gösterilir (UI de ayrıca devre dışı bırakır — iki katman).
 */
export async function voidLicenseItemAction(input: {
  id: string;
  reason: string;
  productId?: string;
}): Promise<LicenseMutationResult> {
  const id = String(input?.id ?? '').trim();
  if (!UUID_RE.test(id)) return { ok: false, error: 'Geçersiz lisans kaydı.' };
  const reason = String(input?.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'İptal sebebi zorunludur.' };

  try {
    await apiSend(
      'DELETE',
      `/v1/admin/license-items/${id}`,
      { reason: reason.slice(0, 500) },
      await getActor(),
    );
    revalidateInventory(input?.productId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İşlem başarısız.' };
  }
}

/**
 * Tekil lisansı KALICI SİL. `voidLicenseItemAction`in AKSİNE satır GERÇEKTEN silinir →
 * aynı anahtar tekrar girilebilir.
 *
 * NEDEN VAR: mükerrer engeli tablo genelindedir ve statüye bakmaz; "Sil" yalnız `voided`
 * yaptığı için yanlışlıkla girilen bir anahtar sonsuza dek hash'i işgal ediyordu ve operatörün
 * doğrusunu girmesinin HİÇBİR yolu yoktu.
 *
 * OWNER kapısı BURADA da var (API'de `OwnerGuard` zaten var — iki katman): paneldeki en
 * yıkıcı işlem; `rotateAccountCredentialsAction` ile aynı sınırda durur.
 */
export async function purgeLicenseItemAction(input: {
  id: string;
  reason: string;
  productId?: string;
}): Promise<LicenseMutationResult> {
  if (!(await isOwner())) {
    return {
      ok: false,
      error: 'Kalıcı silme için owner yetkisi gerekir — kayıt geri dönüşü olmadan silinir.',
    };
  }
  const id = String(input?.id ?? '').trim();
  if (!UUID_RE.test(id)) return { ok: false, error: 'Geçersiz lisans kaydı.' };
  const reason = String(input?.reason ?? '').trim();
  if (reason.length < 3) return { ok: false, error: 'Sebep zorunludur (en az 3 karakter).' };

  try {
    await apiSend(
      'DELETE',
      `/v1/admin/license-items/${id}/purge`,
      { reason: reason.slice(0, 500) },
      await getActor(),
    );
    revalidateInventory(input?.productId);
    // Kalem Kusurlu Stok listesinden de DÜŞER (o ekran voided kalemleri gösterir) → orayı da
    // tazele, yoksa operatör sildiği kaydı orada görmeye devam eder.
    revalidatePath('/quarantine');
    revalidatePath('/quarantine/records');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İşlem başarısız.' };
  }
}

/**
 * Tekil lisansın payload'ını DEĞİŞTİR (yanlış girilmiş anahtar/hesap düzeltme). Yeni değer
 * API'de yeniden şifrelenir; sebep audit'e yazılır. Teslim edilmiş lisansta 409 (o akış
 * sipariş detayındaki "Değiştir" işlemidir — müşterideki anahtar sessizce bozulmasın).
 */
export async function updateLicenseItemAction(input: {
  id: string;
  reason: string;
  value?: string;
  fields?: Record<string, string>;
  productId?: string;
}): Promise<LicenseMutationResult> {
  const id = String(input?.id ?? '').trim();
  if (!UUID_RE.test(id)) return { ok: false, error: 'Geçersiz lisans kaydı.' };
  const reason = String(input?.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'Değişiklik sebebi zorunludur.' };

  const body: Record<string, unknown> = { reason: reason.slice(0, 500) };
  if (input?.fields && typeof input.fields === 'object') {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.fields)) fields[String(k)] = String(v ?? '');
    if (Object.keys(fields).length === 0) {
      return { ok: false, error: 'Hesap alanları boş olamaz.' };
    }
    body.fields = fields;
  } else {
    const value = String(input?.value ?? '').trim();
    if (!value) return { ok: false, error: 'Yeni lisans değeri zorunludur.' };
    body.value = value;
  }

  try {
    await apiSend('PATCH', `/v1/admin/license-items/${id}`, body, await getActor());
    revalidateInventory(input?.productId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İşlem başarısız.' };
  }
}

/**
 * TESLİM EDİLMİŞ hesabın kimlik bilgilerini YERİNDE günceller (sağlayıcıda parola değişti).
 *
 * NEDEN AYRI: "Değiştir" (replace) hesap ürününde YANLIŞ araçtır — müşteriye BAŞKA bir hesap
 * verir, eski hesap müşterinin elinde çalışmaya devam eder ve müşterinin o hesapta biriktirdiği
 * veri kaybolur. Bu akış AYNI kalemi ve AYNI atamayı korur, yalnız kimlik bilgilerini yeniler.
 *
 * OWNER-ONLY: uç düz metin kimlik bilgisi kabul eder ve müşteride ÇALIŞAN bir lisansı
 * değiştirir. API'de de `OwnerGuard` vardır (savunma-derinliği); birincil kapı buradadır.
 *
 * NEDEN HÂLÂ BU DOSYADA (kullanıcı kararı sonrası): işlemin BİRİNCİL yeri artık SİPARİŞ
 * DETAYIDIR (müşteriye dokunan her aksiyon orada), ama hedefi bir `license_items` kaydıdır
 * ve uç `/v1/admin/license-items/:id/…` altındadır — yani bu modülün konusudur. Ayrıca ürün
 * detayındaki envanter de (şema orada bilinir) aynı aksiyonu çağırır; siparişe taşımak
 * ikinci bir kopya doğururdu. `orderId` verilirse sipariş detayı da yeniden doğrulanır.
 */
export async function rotateAccountCredentialsAction(input: {
  id: string;
  fields: Record<string, string>;
  reason: string;
  productId?: string;
  /** Sipariş detayından çağrıldıysa o sayfa da tazelenir (yalnız uuid ise). */
  orderId?: string;
}): Promise<LicenseMutationResult & { orderIds?: string[] }> {
  if (!(await isOwner())) {
    return {
      ok: false,
      error:
        'Bu işlem için owner yetkisi gerekir — teslim edilmiş bir lisansın kimlik bilgilerini değiştirir.',
    };
  }
  const id = String(input?.id ?? '').trim();
  if (!UUID_RE.test(id)) return { ok: false, error: 'Geçersiz lisans kaydı.' };
  const reason = String(input?.reason ?? '').trim();
  if (reason.length < 3) return { ok: false, error: 'Sebep zorunludur (en az 3 karakter).' };

  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(input?.fields ?? {})) fields[String(k)] = String(v ?? '');
  if (Object.keys(fields).length === 0) {
    return { ok: false, error: 'Hesap alanları boş olamaz.' };
  }

  try {
    const res = (await apiPost(
      `/v1/admin/license-items/${id}/rotate-credentials`,
      { fields, reason: reason.slice(0, 500) },
      await getActor(),
    )) as { orderIds?: string[] } | null;
    revalidateInventory(input?.productId);
    // Sipariş detayı: müşterinin gördüğü hesap alanları BURADA da render ediliyor →
    // tazelenmezse operatör güncellemeden sonra ESKİ parolayı görmeye devam ederdi.
    const orderId = String(input?.orderId ?? '').trim();
    if (UUID_RE.test(orderId)) revalidatePath(`/orders/${orderId}`);
    return { ok: true, orderIds: res?.orderIds ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İşlem başarısız.' };
  }
}

/**
 * TOPLU "geçersiz kıl / hasarlı" — envanter listesinden çoklu seçimle stoktan düşürme.
 *
 * NEDEN TOPLU (kullanıcı geri bildirimi): bozuk bir tedarikçi partisi geldiğinde anahtarları
 * tek tek bir seçiciden bulmak operasyonel olarak imkânsızdı. Artık operatör listede süzer
 * (parti / tedarikçi / arama), kutuları işaretler ve tek sebeple hepsini düşer.
 *
 * ÜRÜNE GÖRE GRUPLAMA ÇAĞIRANDA: `/v1/admin/stock-adjustments` ürün-kapsamlıdır (fire ve
 * maliyet defteri ürün bazında tutulur). Genel `/stock` listesinde seçim farklı ürünlere
 * yayılabildiği için istemci grupları ayırıp bu action'ı grup başına çağırır.
 */
export async function bulkAdjustLicenseItemsAction(input: {
  productId: string;
  licenseItemIds: string[];
  action: 'void' | 'damage';
  reason: string;
}): Promise<
  { ok: true; affected: number; skipped: number; qtyTotal: number } | { ok: false; error: string }
> {
  const productId = String(input?.productId ?? '').trim();
  if (!UUID_RE.test(productId)) return { ok: false, error: 'Geçersiz ürün kaydı.' };

  const action = input?.action;
  if (action !== 'void' && action !== 'damage') return { ok: false, error: 'Geçersiz işlem türü.' };

  const reason = String(input?.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'Sebep zorunludur (denetim kaydına yazılır).' };

  // Benzersizleştir + doğrula. API üst sınırı 500; burada da kesilir ki sunucuya asla
  // reddedilecek bir istek gitmesin (istemci sayfa boyutu en çok 100).
  const ids = Array.from(new Set((input?.licenseItemIds ?? []).map((v) => String(v).trim()))).filter(
    (v) => UUID_RE.test(v),
  );
  if (ids.length === 0) return { ok: false, error: 'Hiç lisans seçilmedi.' };
  if (ids.length > 500) return { ok: false, error: 'Tek seferde en çok 500 lisans işlenebilir.' };

  try {
    const res = await apiPost<{ affected?: number; skipped?: number; qtyTotal?: number } | null>(
      '/v1/admin/stock-adjustments',
      { productId, licenseItemIds: ids, action, reason: reason.slice(0, 500) },
      await getActor(),
    );
    revalidateInventory(productId);
    // Kusurlu stok ÜÇ AYRI ROTA: '/quarantine' revalidate'i alt rotaları KAPSAMAZ → yeni
    // geçersiz kılınan kalem hem havuzda hem defterde görünmeli.
    revalidatePath('/quarantine');
    revalidatePath('/quarantine/records');
    return {
      ok: true,
      affected: Number(res?.affected ?? 0),
      skipped: Number(res?.skipped ?? 0),
      qtyTotal: Number(res?.qtyTotal ?? 0),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İşlem başarısız.' };
  }
}

/*
 * KALDIRILDI: `replaceDeliveredLicenseAction` (müşterideki anahtarı yenisiyle değiştirme).
 *
 * KULLANICI KARARI: "son eklenen lisanslar kısmında müşterinin lisansını yenilemem
 * değiştirebilmem saçma; bunu sadece o siparişin içerisine girip yapabilmem daha sağlıklı."
 * Envanter ekranının işi (a) stoktakileri görmek ve (b) YANLIŞ GİRİLMİŞ kaydı düzeltmektir;
 * müşteride CANLI bir lisansı değiştirmek sipariş bağlamı (hangi müşteri, hangi satır, hangi
 * garanti penceresi) gerektirir ve o bağlam yalnız sipariş detayında vardır.
 *
 * Aksiyon SİLİNDİ, "kullanılmıyor" diye bırakılmadı: bir sunucu aksiyonu, hiçbir bileşen
 * çağırmasa bile çağrılabilir bir uçtur (bu projede ölü `revealAction` tam da bu yüzden
 * kaldırılmıştı). İşin kendisi kaybolmadı — AYNI uç (`POST /v1/admin/assignments/:id/replace`)
 * sipariş detayındaki "Değiştir" düğmesinden çalışmaya devam ediyor; envanter satırı da o
 * siparişe bağlantı verir.
 */

/**
 * Çok kullanımlık (MAK) bir kalemin KALAN KULLANIM HAKKINI yeniden ayarlar.
 *
 * NEDEN VAR (kullanıcı ihtiyacı): "1000 kullanım hakkı vardı, 900 kalmış; bunu manuel olarak
 * tekrar 1000'e çıkartabilmeliyim." Tedarikçi bir MAK anahtarına sonradan aktivasyon
 * tanımlayabilir; panelde bunun aracı yoktu (ürün seviyesindeki `maxUses` yalnız YENİ girilen
 * kalemlere uygulanır) ve kapasitesi tükenen anahtar hiçbir şekilde geri döndürülemiyordu.
 *
 * İŞ KURALI SUNUCUDA: `use_count` (teslim edilmiş aktivasyon) ASLA düşürülmez — yalnız tavan
 * (`max_uses = use_count + remainingUses`) hareket eder, aksi halde aynı aktivasyonlar ikinci
 * kez satılabilir görünürdü (§2 sessiz aşırı-satış + mutabakat alarmı).
 *
 * OWNER-ONLY: satılabilir stok miktarını doğrudan değiştirir. API'de de `OwnerGuard` vardır
 * (savunma-derinliği); birincil kapı buradadır — tıklanıp 403 veren düğme sunulmasın.
 */
export async function adjustLicenseCapacityAction(input: {
  id: string;
  remainingUses: number;
  reason: string;
  productId?: string;
}): Promise<
  | {
      ok: true;
      maxUses: number;
      useCount: number;
      remainingUses: number;
      status: string;
      /** Bu düzeltmenin AÇTIĞI kapasiteyle hemen teslim edilen bekleyen sipariş satırı sayısı. */
      autoCompleted: number;
      /** Kalan backlog arka plana atıldı mı (büyük kuyruk). */
      autoCompleteQueued: boolean;
      /** Kapasite YAZILDI ama bekleyen sipariş taraması koşamadı (kısmi başarı — sessiz kalmaz). */
      autoCompleteFailed: boolean;
    }
  | { ok: false; error: string }
> {
  if (!(await isOwner())) {
    return {
      ok: false,
      error:
        'Bu işlem için owner yetkisi gerekir — satılabilir stok miktarını doğrudan değiştirir.',
    };
  }
  const id = String(input?.id ?? '').trim();
  if (!UUID_RE.test(id)) return { ok: false, error: 'Geçersiz lisans kaydı.' };

  const remainingUses = Number(input?.remainingUses);
  if (!Number.isInteger(remainingUses) || remainingUses < 0) {
    return { ok: false, error: 'Kalan kullanım hakkı 0 veya daha büyük bir tam sayı olmalı.' };
  }

  const reason = String(input?.reason ?? '').trim();
  if (reason.length < 3) return { ok: false, error: 'Sebep zorunludur (en az 3 karakter).' };

  try {
    const res = (await apiPost(
      `/v1/admin/license-items/${id}/capacity`,
      { remainingUses, reason: reason.slice(0, 500) },
      await getActor(),
    )) as {
      maxUses?: number;
      useCount?: number;
      remainingUses?: number;
      status?: string;
      autoCompleted?: number;
      autoCompleteQueued?: boolean;
      autoCompleteFailed?: boolean;
    } | null;
    revalidateInventory(input?.productId);
    // Kapasite artışı `depleted` kalemi `available` yapabilir → parti sayaçları (Stokta /
    // Müşterilerde / Düşmüş) ve parti listesi değişir. Parti detayı dinamik segment olduğu
    // için sayfa ŞABLONUYLA tazelenir.
    revalidatePath('/batches');
    revalidatePath('/batches/[id]', 'page');

    // Açılan kapasite bekleyen satırları TESLİM ETMİŞ olabilir (API kapasite artışında stok
    // girişiyle aynı tamamlama yolunu koşar) → sipariş yüzeyleri bayat kalmasın. Yalnız gerçekten
    // teslimat olduysa tazelenir (her kapasite düzenlemesinde tüm sipariş ekranlarını atmak yerine).
    const autoCompleted = Number(res?.autoCompleted ?? 0);
    if (autoCompleted > 0) {
      revalidatePath('/pending');
      revalidatePath('/orders');
      revalidatePath('/dashboard');
    }

    return {
      ok: true,
      maxUses: Number(res?.maxUses ?? 0),
      useCount: Number(res?.useCount ?? 0),
      remainingUses: Number(res?.remainingUses ?? 0),
      status: String(res?.status ?? ''),
      autoCompleted,
      autoCompleteQueued: Boolean(res?.autoCompleteQueued),
      autoCompleteFailed: Boolean(res?.autoCompleteFailed),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İşlem başarısız.' };
  }
}
