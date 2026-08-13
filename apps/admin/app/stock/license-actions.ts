'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, apiRaw, apiSend } from '../../lib/api';
import { getActor } from '../../lib/session';

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
const PAGE_SIZES = [25, 50, 100];
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
  total: number;
  page: number;
  pageSize: number;
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

  const rawPage = Number(params.page);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(Math.floor(rawPage), MAX_PAGE) : 1;
  qs.set('page', String(page));

  const rawSize = Number(params.pageSize);
  qs.set('pageSize', String(PAGE_SIZES.includes(rawSize) ? rawSize : PAGE_SIZES[0]));

  if (params.sort && SORTS.includes(params.sort)) qs.set('sort', params.sort);

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

/**
 * TESLİM EDİLMİŞ bir anahtarı müşteride YENİSİYLE değiştir (§4 proaktif değişim).
 *
 * NEDEN ENVANTERDEN: bir tedarikçi partisi geri çekildiğinde stoktakiler geçersiz kılınır ama
 * müşterilerdeki anahtarlara DOKUNULMAZ — bir kısmı çalışıyor olabilir. Operatörün ihtiyacı
 * "hangileri hâlâ müşterilerde" listesini görüp SATIR SATIR karar vermek. Bugüne dek tek yol
 * her anahtar için ilgili siparişi tek tek açmaktı; artık aynı işlem listeden yapılır.
 *
 * AYNI UÇ, YENİ YÜZEY: `POST /v1/admin/assignments/:id/replace` (sipariş detayındakiyle
 * BİREBİR aynı) → stok ön-kontrolü, tek transaction (added=0 ⇒ rollback ⇒ eski anahtar CANLI
 * kalır), eski anahtar karantinaya, soyağacı `assignment_history`'ye yazılır. Burada iş kuralı
 * TEKRARLANMAZ; MAK/çok-kullanımlı ürün API'de 400 ile reddedilir ve mesaj aynen gösterilir.
 */
export async function replaceDeliveredLicenseAction(input: {
  assignmentId: string;
  reason: string;
  productId?: string;
  orderId?: string;
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const assignmentId = String(input?.assignmentId ?? '').trim();
  if (!UUID_RE.test(assignmentId)) return { ok: false, error: 'Geçersiz atama kaydı.' };
  const reason = String(input?.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'Değişim sebebi zorunludur (denetim kaydına yazılır).' };

  try {
    await apiPost(
      `/v1/admin/assignments/${assignmentId}/replace`,
      { reason: reason.slice(0, 500) },
      await getActor(),
    );
    revalidateInventory(input?.productId);
    // Değiştirilen (ölü) anahtar havuza ve deftere düşer — ikisi ayrı rota (bkz. yukarıdaki not).
    revalidatePath('/quarantine');
    revalidatePath('/quarantine/records');
    revalidatePath('/batches');
    // Parti detayı dinamik segment → sayfa şablonuyla tazelenir (sayaçlar güncellensin).
    revalidatePath('/batches/[id]', 'page');
    if (input?.orderId && UUID_RE.test(input.orderId)) revalidatePath(`/orders/${input.orderId}`);
    return { ok: true, message: 'Yeni kalem atandı — eskisi karantinaya alındı.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Değişim başarısız.' };
  }
}
