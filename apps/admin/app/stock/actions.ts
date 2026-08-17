'use server';
import { revalidatePath } from 'next/cache';
import { ApiError, apiGet, apiPost, apiSend, isUuid, type CatalogRow } from '../../lib/api';
import { getActor } from '../../lib/session';

/**
 * SEC-1 — YOL ENJEKSİYONU: ürün/eşleme kimlikleri API YOLUNA gömülür ve sunucu aksiyonları
 * TS tiplerini ÇALIŞMA ANINDA zorlamaz (uç dışarıdan serileştirilmiş argümanla çağrılabilir)
 * → `'../sites/<id>/rotate-secret?x='` gibi bir değer BOŞ DEĞİL ama WHATWG URL
 * normalizasyonuyla owner-only bir uca düşerdi. Bu dosyada ZATEN iki yerde satır-içi UUID
 * kalıbı vardı; hepsi paylaşılan `isUuid`'e bağlandı (iki ayrı kalıp tutmak sapma üretir).
 * `lib/api` merkezî `assertSafePath` kapısı ikinci savunma hattıdır.
 */
import { MAX_IMPORT_ITEMS, MAX_USES_CAP, MAX_USES_MIN } from './import/limits';
import { liraToCents, type ImportItemInput } from './import/parse';
// Ürün formu → API gövdesi. `'use server'` dosyasında yaşayamaz (export yasağı → test edilemez);
// gerekçesi ve `guideId`'nin sessizce düşme hikâyesi o dosyanın başında yazılı.
import { buildProductBody } from '../../lib/product-form-body';

/**
 * Reddedilen satır. `index` API'nin gönderilen `items[]` dizisindeki SIRASI, `line` ise
 * kullanıcının EKRANDA gördüğü satır numarasıdır — boş/başlık satırları atlandığı için
 * ikisi aynı DEĞİLDİR. `line` yalnız yeni /stock/import ekranı satır haritası gönderince
 * dolar; eski form (keys textarea) için tanımsız kalır (çağıran `index + 1`'e düşer).
 */
export interface ImportRejectionView {
  index: number;
  reason: string;
  line?: number;
}

/**
 * Stok girişiyle AYNI istekte açılan parti (+ otomatik satın alma emri) sonucu.
 * API `ImportResult.newBatch` (apps/api/src/stock/stock.service.ts → NewBatchOutcome)
 * alanlarının aynası. `created=false` iken `reason` NEDEN oluşmadığını söyler.
 */
export interface ImportNewBatchOutcome {
  created: boolean;
  reason?: 'dry_run' | 'all_rejected';
  batchId?: string;
  purchaseOrderId?: string | null;
  supplierId: string | null;
  supplierName: string | null;
  /** Tedarikçi bu istekte oluşturuldu mu (kuru çalıştırmada: oluşturulacak mı). */
  supplierCreated?: boolean;
  /** Ad eşleşmesiyle MEVCUT tedarikçi kullanıldı mı (mükerrer 'Acme' üretilmedi). */
  supplierExisting?: boolean;
  label: string;
  receivedAt: string;
  qtyReceived: number;
  unitCostCents: number | null;
  currency: string | null;
  /** Girilen lisans kayıtlarına COGS maliyet anlık-görüntüsü yazıldı mı. */
  costSnapshotApplied: boolean;
  /** Aynı üründe aynı etiketli parti zaten var mı? Engel DEĞİL — yalnız uyarı. */
  labelDuplicate?: boolean;
}

export interface ImportState {
  ok: boolean;
  error?: string;
  result?: {
    requested: number;
    imported: number;
    duplicates: number;
    rejected: number;
    rejections?: ImportRejectionView[];
    autoCompleted: number;
    /** Inline cap'i aşan bekleyen satırlar arka plan kuyruğuna atıldı mı. */
    autoCompleteQueued?: boolean;
    /**
     * Stok YAZILDI ama bekleyen sipariş taraması koşamadı (kısmi başarı).
     *
     * SESSİZ KALAMAZ: bu alan yokken ekran "N kayıt girildi" diye YEŞİL rapor veriyordu ve
     * bekleyen siparişler stok VARKEN teslim edilmemiş kalıyordu — operatörün bunu "zaten
     * bekleyen talep yoktu"dan ayırt etmesinin yolu yoktu (tek iz sunucu logu).
     */
    autoCompleteFailed?: boolean;
    /** Kuru çalıştırma (§7): true ise hiçbir şey kaydedilmedi (yalnız önizleme). */
    dryRun?: boolean;
    /** Kuru çalıştırma tahmini: dedupe sonrası girilecek satır sayısı. */
    wouldImport?: number;
    /** Aynı istekte parti istendiyse sonucu (istenmediyse hiç dönmez). */
    newBatch?: ImportNewBatchOutcome;
    /** Yapıştırılan satır sayısı ≠ gerçekten kaydedilen adet (mükerrer/ret) uyarısı. */
    qtyMismatch?: { declared: number; imported: number };
    /**
     * Mükerrerin NEDENİ (API aynası). "1 mükerrer atlandı" tek başına operatörü çıkmaza
     * sokuyordu: kendi iptal ettiği kayıtla çakıştığını hiçbir yerde söylemiyordu.
     * Anahtar/hash TAŞIMAZ — yalnız sayaç + statü kırılımı.
     */
    duplicateDetail?: {
      inRequest: number;
      existingByStatus: Record<string, number>;
      otherProduct: number;
    };
  };
}

/** Stok girişi ekranındaki parti seçici satırı (yalnız AKTİF partiler listelenir). */
export interface ProductBatchOption {
  id: string;
  label: string;
  status: string;
  receivedAt: string | null;
  supplierName: string | null;
  qtyReceived: number;
}

/** Maliyet girildi ama tedarikçi yok — API ile AYNI metin (tek dil). */
const COST_NEEDS_SUPPLIER =
  'Birim maliyet girildi ama tedarikçi seçilmedi. Maliyet satın alma emrinde tutulur; ' +
  'tedarikçi seçin ya da maliyeti boş bırakın.';

/**
 * Yeni parti (`newBatch`) gövdesini form alanlarından kurar.
 *
 * BOŞ ALAN GÖNDERİLMEZ: API `receivedAt` için `.datetime()`, `supplierId` için `.uuid()`
 * bekler — boş string bu doğrulamaları 400'e düşürürdü. Doğrulama burada da yapılır ki
 * operatör API'nin İngilizce/teknik hatası yerine Türkçe, alan-özel mesaj görsün.
 */
function buildNewBatchBody(formData: FormData): { body?: Record<string, unknown>; error?: string } {
  const label = String(formData.get('batchLabel') || '').trim();
  if (!label) return { error: 'Yeni parti için etiket zorunlu (ör. 2026-08-13-A).' };

  const supplierId = String(formData.get('supplierId') || '').trim();
  const supplierName = String(formData.get('supplierName') || '').trim();
  if (supplierId && supplierName) {
    return {
      error: 'Tedarikçi ya listeden seçilir ya da yeni ad girilir — ikisi birlikte gönderilemez.',
    };
  }

  // Maliyet KURUŞ değil LİRA olarak girilir; dönüşüm tek yerde (parse.liraToCents).
  const costRaw = String(formData.get('unitCostLira') || '').trim();
  let unitCostCents: number | null = null;
  if (costRaw) {
    unitCostCents = liraToCents(costRaw);
    if (unitCostCents == null) {
      return { error: 'Birim maliyet okunamadı. Lira olarak girin — ör. 12,50' };
    }
  }
  if (unitCostCents != null && !supplierId && !supplierName) return { error: COST_NEEDS_SUPPLIER };

  // <input type="date"> → 'yyyy-mm-dd'; API ISO datetime ister. Yerel gün başlangıcı
  // kullanılır (sunucu TZ Europe/Istanbul) → maliyet raporu ayları doğru bucket'lanır.
  const receivedAtRaw = String(formData.get('receivedAt') || '').trim();
  let receivedAt: string | undefined;
  if (receivedAtRaw) {
    const d = new Date(`${receivedAtRaw}T00:00:00`);
    if (Number.isNaN(d.getTime())) return { error: 'Alım tarihi okunamadı.' };
    receivedAt = d.toISOString();
  }

  const currency = String(formData.get('currency') || '').trim().toUpperCase();
  const notes = String(formData.get('batchNotes') || '').trim();

  return {
    body: {
      label,
      ...(supplierId ? { supplierId } : {}),
      ...(supplierName ? { supplierName } : {}),
      ...(receivedAt ? { receivedAt } : {}),
      ...(unitCostCents != null ? { unitCostCents } : {}),
      ...(currency ? { currency } : {}),
      ...(notes ? { notes } : {}),
    },
  };
}

/** Kullanım hakkı okunamadı — API'nin İngilizce/teknik hatası yerine tek Türkçe metin. */
const MAX_USES_INVALID =
  `Anahtar başına kullanım hakkı ${MAX_USES_MIN}–${MAX_USES_CAP.toLocaleString('tr-TR')} ` +
  'arası bir tam sayı olmalı. Sayfayı yenileyip tekrar deneyin.';

export interface FormState {
  ok: boolean;
  error?: string;
  /**
   * Eşleme kurulduktan SONRA geriye dönük çözülen bekleyen satırların özeti (§3).
   * Kullanıcının şikâyeti buydu: "eşledim ama sipariş hâlâ eşlenmemiş görünüyor" — eşleme artık
   * eski bekleyen satırlara da uygulanır ve sonucu burada raporlanır.
   */
  resolved?: { linked: number; delivered: number; stillPending: number };
}

/** Bekleyen satır çözümü sonucu (POST /v1/admin/pending-lines/resolve). */
export interface ResolvePendingSummary {
  scanned: number;
  linked: number;
  delivered: number;
  stillPending: number;
  noMapping: number;
  skipped: number;
  truncated: boolean;
  /**
   * Satır başına sonuç açıklaması. Panel "hiç satır bağlanmadı" durumunda GERÇEK sebebi
   * göstermek için ilk kaydın `message`'ını okur (nötr "rapor" kutusu yerine dürüst uyarı).
   * Opsiyonel: eski API sürümü bu alanı döndürmeyebilir.
   */
  details?: Array<{ lineId: string; outcome: string; message: string }>;
}

/** Ürün oluşturma — useActionState uyumlu; doğrulama hatası (ör. multi⇒maxUses, account⇒schema)
 *  tüm /stock sayfasını çökertmek yerine formda inline yüzeye çıkar. */
export async function createProductAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    await apiPost('/v1/admin/products', buildProductBody(formData), await getActor());
    revalidatePath('/stock');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/** Ürün düzenleme — useActionState uyumlu; hata (ör. duplicate SKU) yüzeye çıkar. */
export async function updateProductAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const id = String(formData.get('id') || '');
  if (!isUuid(id)) return { ok: false, error: 'Geçersiz ürün kimliği — sayfa yenilenmeli.' };
  try {
    await apiSend(
      'PATCH',
      `/v1/admin/products/${id}`,
      buildProductBody(formData, true),
      await getActor(),
    );
    // Düzenleme sheet'i hem /stock listesinde hem ürün detayında açılabilir → ikisini de tazele.
    revalidatePath('/stock');
    revalidatePath(`/products/${id}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/**
 * Stok import (§12). İki girdi yolu:
 *  · `itemsJson` — yeni "Stok Girişi" ekranı (app/stock/import). İstemci kayıtları (key satırı ya da hesap
 *    NESNESİ) ve her kaydın EKRANDAKİ satır numarasını birlikte gönderir → reddedilen satır
 *    raporu doğru satırı işaret eder. Hesap satırları API'ye NESNE olarak gider (payload
 *    union'ı nesneyi kabul eder) — JSON string'e çevrilmez.
 *  · `keys` — ürün detayındaki mevcut form (her satır bir key). GERİYE DÖNÜK korunur.
 *
 * Parti üç moddan biriyle bağlanır (`batchMode`): partisiz · mevcut parti (`batchId`) ·
 * stok girişiyle AYNI istekte açılan yeni parti (`newBatch`). İkisi karşılıklı dışlayıcıdır.
 *
 * KULLANIM HAKKI (`maxUses`): kayıt başına opsiyonel MAK kapasitesi taşınır (partiden partiye
 * değişir — bkz. `ImportItemInput.maxUses`). Değer İSTEMCİDE üretilir ama BURADA yeniden
 * doğrulanır: sunucu aksiyonları çalışma anında tip zorlamaz, uç dışarıdan serileştirilmiş
 * argümanla çağrılabilir. Ürünün çok kullanımlık olup olmadığını bu katman BİLEMEZ (ürünü
 * çekmez) — o kapıyı API tutar (tek kullanımlık üründe 1 dışında değer ⇒ 400) ve arayüz alanı
 * yalnız multi üründe render edilir. Bu yüzden buradaki doğrulama ŞEKİL doğrulamasıdır ve
 * geçersiz değeri SESSİZCE DÜŞÜRMEZ (düşürseydi ürün varsayılanı uygulanır, operatör yanlış
 * kapasiteyi hiç fark etmezdi) — tüm istek anlaşılır bir hatayla reddedilir.
 */
export async function importStockAction(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const productId = String(formData.get('productId') || '');
  // Kuru çalıştırma (§7): "Kuru Çalıştır" butonu name=dryRun value=true gönderir.
  const dryRun = String(formData.get('dryRun') || '') === 'true';
  if (!productId) return { ok: false, error: 'Ürün seçin' };

  const items: Array<{ payload: string | Record<string, string>; maxUses?: number }> = [];
  /** items[i] → kullanıcının ekranda gördüğü satır no (rejections eşlemesi için). */
  const sourceLines: number[] = [];

  const itemsJson = String(formData.get('itemsJson') || '').trim();
  if (itemsJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(itemsJson);
    } catch {
      return { ok: false, error: 'Girilen kayıtlar okunamadı (biçim hatası). Tekrar deneyin.' };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: 'Girilen kayıtlar okunamadı (beklenmeyen biçim).' };
    }
    /** forEach içinden erken dönülemez → hata bayrak olarak taşınır, döngüden sonra döner. */
    let maxUsesError = false;
    parsed.forEach((raw, i) => {
      const it = raw as ImportItemInput | null;
      const payload = it?.payload;
      // `maxUses` alanı HİÇ yoksa (tek kullanımlık ürün / varsayılanı kullanan giriş) alan
      // gövdeye eklenmez → API ürünün varsayılanını uygular (eski davranış birebir).
      const rawMaxUses = it?.maxUses;
      let maxUses: number | undefined;
      if (rawMaxUses !== undefined && rawMaxUses !== null) {
        if (
          typeof rawMaxUses !== 'number' ||
          !Number.isSafeInteger(rawMaxUses) ||
          rawMaxUses < MAX_USES_MIN ||
          rawMaxUses > MAX_USES_CAP
        ) {
          maxUsesError = true;
          return;
        }
        maxUses = rawMaxUses;
      }
      if (typeof payload === 'string') {
        if (!payload) return;
        items.push({ payload, ...(maxUses !== undefined ? { maxUses } : {}) });
      } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        items.push({
          payload: payload as Record<string, string>,
          ...(maxUses !== undefined ? { maxUses } : {}),
        });
      } else {
        return;
      }
      const line = it?.line;
      sourceLines.push(typeof line === 'number' && line > 0 ? line : i + 1);
    });
    if (maxUsesError) return { ok: false, error: MAX_USES_INVALID };
  } else {
    String(formData.get('keys') || '')
      .split('\n')
      .forEach((l, i) => {
        const trimmed = l.trim();
        if (!trimmed) return;
        items.push({ payload: trimmed });
        sourceLines.push(i + 1);
      });
  }

  if (items.length === 0) return { ok: false, error: 'En az bir kayıt girin' };
  if (items.length > MAX_IMPORT_ITEMS) {
    return {
      ok: false,
      error: `Tek seferde en çok ${MAX_IMPORT_ITEMS.toLocaleString('tr-TR')} kayıt girilebilir. Girdiyi bölün.`,
    };
  }

  // Parti modu: yeni ekran `batchMode` gönderir; eski form yalnız `batchId` (mod alanı yok).
  const batchIdRaw = String(formData.get('batchId') || '').trim();
  const batchMode = String(formData.get('batchMode') || '').trim();
  let batchId: string | undefined;
  let newBatch: Record<string, unknown> | undefined;
  if (batchMode === 'new') {
    const built = buildNewBatchBody(formData);
    if (built.error) return { ok: false, error: built.error };
    newBatch = built.body;
  } else if (batchMode === 'existing' || (!batchMode && batchIdRaw)) {
    batchId = batchIdRaw || undefined;
  }

  try {
    const result = await apiPost<NonNullable<ImportState['result']>>(
      '/v1/admin/stock/import',
      {
        productId,
        items,
        // Boşsa gönderme — API opsiyonel uuid bekler (boş string uuid doğrulamasını bozar).
        ...(batchId ? { batchId } : {}),
        ...(newBatch ? { newBatch } : {}),
        // Kuru çalıştırmada yalnız true gönder; gerçek import'ta bayrağı hiç ekleme.
        ...(dryRun ? { dryRun: true } : {}),
      },
      await getActor(),
    );

    // Reddedilen satırlara EKRANDAKİ satır numarasını iliştir (API yalnız items[] sırasını
    // bilir; boş/başlık satırları atlandığı için ikisi aynı değildir).
    const rejections = (result?.rejections ?? []).map((r) => ({
      index: r.index,
      reason: r.reason,
      ...(sourceLines[r.index] != null ? { line: sourceLines[r.index] } : {}),
    }));

    // Kuru çalıştırma DB'yi değiştirmez → cache invalidation gereksiz; yalnız gerçek import'ta.
    if (!dryRun) {
      revalidatePath(`/products/${productId}`);
      revalidatePath('/stock');
      revalidatePath('/stock/import');
      // Parti/satın alma emri sayaçları bu istekte değişebilir (newBatch) ya da mevcut
      // partiye kayıt eklenir → iki ekran da bayat kalmasın (eskiden eksikti).
      revalidatePath('/batches');
      revalidatePath('/purchase-orders');
      // Stok gelince bekleyen satırlar tamamlanmış olabilir.
      if (result?.autoCompleted) {
        revalidatePath('/orders');
        revalidatePath('/pending');
      }
    }
    return { ok: true, result: { ...result, rejections } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/**
 * Bir ÜRÜNE ait aktif partiler (stok girişi ekranındaki "mevcut parti" seçicisi).
 *
 * NEDEN AYRI ÇAĞRI: `GET /v1/admin/batches` iki tam GROUP BY (satılmış/satılmamış sayımı)
 * yapar → tüm partileri sayfa açılışında önden yüklemek pahalı. Ürün seçilince/değişince
 * yalnız o an gerekli liste çekilir.
 *
 * SÜZGEÇ SUNUCUDA: `?productId=` gönderilir — uç, üst sınırı (LIMIT) o ürünün partilerine
 * uygular. Süzme yalnız istemcide kalsaydı, ürünün AKTİF partisi global "en yeni N" penceresinin
 * dışında kaldığında seçicide hiç görünmez ve operatöre "bu ürünün aktif partisi yok" denirdi.
 * Aşağıdaki `productId` eşitliği yine de UYGULANIR: parametreyi tanımayan eski API sürümüne
 * (deploy sapması) karşı savunmadır — o durumda davranış eski hâline döner.
 *
 * Yalnız `status='active'` partiler döner: API aktif olmayan partiye stok eklemeyi 409 ile
 * reddeder (recall süpürmesi geçmiş partiye taze anahtar eklenmesin) — listede göstermek
 * garantili bir hataya davet olurdu. Elenen adet `inactiveCount` ile DÜRÜSTÇE bildirilir.
 */
export async function fetchProductBatchesAction(productId: string): Promise<{
  ok: boolean;
  batches?: ProductBatchOption[];
  inactiveCount?: number;
  /** Sunucu parti listesini üst sınırda kırptı → bu ürünün ESKİ partileri eksik olabilir. */
  listTruncated?: boolean;
  error?: string;
}> {
  const id = String(productId || '').trim();
  if (!isUuid(id)) {
    return { ok: false, error: 'Geçersiz ürün' };
  }
  interface RawBatch {
    id: string;
    label: string;
    productId: string;
    status: string;
    qtyReceived?: number;
    receivedAt?: string | null;
    supplierName?: string | null;
  }
  try {
    // API dizi VEYA {items} döndürebilir (batches/queries.ts ile aynı savunma).
    const data = await apiGet<RawBatch[] | { items: RawBatch[]; truncated?: boolean }>(
      `/v1/admin/batches?productId=${encodeURIComponent(id)}`,
    );
    const listTruncated = !Array.isArray(data) && data?.truncated === true;
    const all = (Array.isArray(data) ? data : (data?.items ?? [])).filter(
      (b) => b?.productId === id,
    );
    const active = all.filter((b) => b.status === 'active');
    return {
      ok: true,
      inactiveCount: all.length - active.length,
      // Sunucu bu ÜRÜNÜN parti listesini bile üst sınırda kırptıysa (ya da eski API sürümünde
      // süzgeç uygulanmadıysa) eski partiler eksik olabilir → sessiz bırakılmaz (dürüst-kırpma).
      listTruncated,
      batches: active.map((b) => ({
        id: b.id,
        label: b.label,
        status: b.status,
        receivedAt: b.receivedAt ?? null,
        supplierName: b.supplierName ?? null,
        qtyReceived: Number(b.qtyReceived ?? 0),
      })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Partiler alınamadı' };
  }
}

export interface PreviewState {
  ok: boolean;
  error?: string;
  result?: {
    count: number;
    pendingLines: number;
    pendingUnits: number;
    /**
     * Stok girişiyle OTOMATİK dolacak bekleyen birim (efektif politika partial-auto +
     * ön sipariş penceresi kapalı). İstemci `wouldFill = min(satır sayısı, autoUnits)`
     * hesabını BUNDAN yapar → satır sayısı değiştikçe yeni ağ turu gerekmez.
     */
    autoUnits: number;
    /** Otomatik DOLMAYACAK bekleyen birim (all-or-nothing / onaylı / ön sipariş). */
    manualUnits: number;
    wouldFill: number;
    remainingAfter: number;
  };
}

/**
 * "Onayla ve Dağıt" önizleme (§13) — salt-okunur. Girilecek stok adedi (count)
 * bekleyen talebi ne kadar karşılar; import mantığını TETİKLEMEZ.
 */
export async function previewStockAction(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  const productId = String(formData.get('productId') || '');
  const count = Number(String(formData.get('count') || '0')) || 0;
  if (!productId) return { ok: false, error: 'Ürün seçin' };
  try {
    const result = await apiPost<PreviewState['result']>(
      '/v1/admin/stock/preview',
      {
        productId,
        count: Math.max(0, Math.floor(count)),
      },
      // Aktör iletilir (diğer stok çağrılarıyla simetri; API tarafında audit/izleme
      // aynı admin'e attribute edilir). Eskiden bu çağrıda eksikti.
      await getActor(),
    );
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/**
 * Site-ürün eşleme oluştur — useActionState uyumlu. duplicate (aynı
 * site+remote ürün+varyasyon UNIQUE) hatası yüzeye çıkar; sessiz atlanmaz.
 */
export async function createMappingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const siteId = String(formData.get('siteId') || '');
  const productId = String(formData.get('productId') || '');
  const remoteProductId = String(formData.get('remoteProductId') || '').trim();
  if (!siteId || !productId || !remoteProductId) {
    return { ok: false, error: 'Site, ürün ve mağaza ürün ID zorunlu' };
  }
  const remoteVariationId = String(formData.get('remoteVariationId') || '').trim();
  const bundleQtyRaw = String(formData.get('bundleQty') || '').trim();
  const bundleQty = bundleQtyRaw ? Number(bundleQtyRaw) : undefined;
  try {
    await apiPost(
      '/v1/admin/mappings',
      {
        siteId,
        productId,
        remoteProductId,
        ...(remoteVariationId ? { remoteVariationId } : {}),
        ...(bundleQty && bundleQty > 0 ? { bundleQty } : {}),
      },
      await getActor(),
    );
    // Eşleme oluşturma artık ürün detayında (ürün-merkezli) → o sayfayı tazele.
    revalidatePath(`/products/${productId}`);

    // GERİYE DÖNÜK UYGULAMA (§3): eşleme yapılmadan önce gelmiş ve product_id=NULL kalmış bekleyen
    // satırlar, bu eşleme sayesinde artık çözülebilir. Kullanıcının bildirdiği hata tam buydu —
    // eşledikten sonra sipariş hâlâ "eşlenmemiş" görünüyordu. OTOMATİK EŞLEME DEĞİL: yalnız
    // operatörün AZ ÖNCE ELLE kurduğu eşleme, eski satırlara uygulanır.
    // Best-effort: burada oluşan hata eşlemeyi başarısız GÖSTERMEZ (eşleme kaydı zaten oluştu).
    let resolved: FormState['resolved'];
    try {
      const r = await apiPost<ResolvePendingSummary>(
        '/v1/admin/pending-lines/resolve',
        {
          siteId,
          remoteProductId,
          ...(remoteVariationId ? { remoteVariationId } : {}),
        },
        await getActor(),
      );
      if (r && (r.linked > 0 || r.delivered > 0)) {
        resolved = { linked: r.linked, delivered: r.delivered, stillPending: r.stillPending };
        revalidatePath('/orders');
        revalidatePath('/pending');
        revalidatePath('/mappings');
      }
    } catch {
      /* çözüm best-effort — operatör /mappings ekranından tekrar tetikleyebilir */
    }

    return { ok: true, ...(resolved ? { resolved } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/**
 * Bekleyen (eşlemesiz) satırları MEVCUT eşlemelerle geriye dönük çöz + teslimatı dene (§3).
 * Filtresiz çağrı tüm eşlemesiz satırları tarar (sunucuda 500 satır sınırı; `truncated` ile bildirilir).
 * Yeni eşleme OLUŞTURMAZ — otomatik eşleştirme yoktur (güvenlik kuralı).
 */
export async function resolvePendingLinesAction(input: {
  siteId?: string;
  remoteProductId?: string;
  remoteVariationId?: string | null;
  orderId?: string;
  lineId?: string;
}): Promise<{ ok: boolean; result?: ResolvePendingSummary; error?: string }> {
  try {
    const result = await apiPost<ResolvePendingSummary>(
      '/v1/admin/pending-lines/resolve',
      {
        ...(input.siteId ? { siteId: input.siteId } : {}),
        ...(input.remoteProductId ? { remoteProductId: input.remoteProductId } : {}),
        // null ANLAMLI ("varyasyonsuz satırlar") — undefined ise alan hiç gönderilmez.
        ...(input.remoteVariationId !== undefined
          ? { remoteVariationId: input.remoteVariationId }
          : {}),
        ...(input.orderId ? { orderId: input.orderId } : {}),
        ...(input.lineId ? { lineId: input.lineId } : {}),
      },
      await getActor(),
    );
    revalidatePath('/mappings');
    revalidatePath('/orders');
    revalidatePath('/pending');
    if (input.orderId) revalidatePath(`/orders/${input.orderId}`);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Bekleyen satırlar çözülemedi' };
  }
}

/**
 * Eşleme mutasyonlarının ortak sonucu (§3).
 *
 * NEDEN (denetim C13): `updateMappingAction`/`removeMappingAction` `catch {}` ile hatayı
 * TAMAMEN yutuyor ve `void` dönüyordu → API 403/500 verse bile ekranda HİÇBİR ŞEY olmuyor,
 * operatör "pasifleştirdim" sanıp ayrılıyordu (eşleme hâlâ aktif, teslimat davranışı
 * beklediğinden farklı). Sessiz yutmanın gerekçesi meşruydu (yakalanmamış throw tüm sayfayı
 * error boundary'ye düşürür) ama doğru çözüm hatayı GÖRÜNMEZ kılmak değil, sayfayı düşürmeden
 * SONUÇ olarak döndürmektir — `app/mappings/actions.ts:removeMappingWithResult` tam bu
 * yetersizlik için yazılmıştı; desen buraya da taşındı.
 */
export interface MappingMutationState {
  ok: boolean;
  error?: string;
}

/** Eşlemeyi pasifleştir/etkinleştir (§3). productId ürün detayını tazelemek için (opsiyonel). */
export async function updateMappingAction(formData: FormData): Promise<MappingMutationState> {
  const id = String(formData.get('id') || '');
  const active = String(formData.get('active') || '') === 'true';
  const productId = String(formData.get('productId') || '').trim();
  // SEC-1: kimlik yola gömülüyor → şekli doğrulanmadan istek YAPILMAZ.
  if (!isUuid(id)) {
    return { ok: false, error: 'Geçersiz eşleme kimliği — liste yenilenip tekrar denenmeli.' };
  }
  let result: MappingMutationState;
  try {
    await apiSend('PATCH', `/v1/admin/mappings/${id}`, { active }, await getActor());
    result = { ok: true };
  } catch (e) {
    // Action ASLA fırlatmaz (yakalanmamış hata tüm sayfayı error boundary'ye düşürürdü);
    // ama artık sessiz de değil — çağıran sonucu ekranda gösterir.
    result = {
      ok: false,
      error: e instanceof Error ? e.message : 'Eşleme durumu değiştirilemedi',
    };
  }
  // Toggle formu productId taşıyorsa ürün detayını tazele; yoksa (geriye dönük) /stock.
  // Hata durumunda da tazelenir: eşleme eşzamanlı silinmiş/değişmiş olabilir, liste gerçeğe döner.
  if (productId) revalidatePath(`/products/${productId}`);
  else revalidatePath('/stock');
  return result;
}

/**
 * Var olan eşlemenin HEDEF panel ürününü DEĞİŞTİR (remap) + bundle — useActionState uyumlu (§3).
 * Mağaza ürünü/site/varyasyon DEĞİŞMEZ; yalnız hangi panel ürününün teslim edeceği değişir. Eşleme
 * her zaman elle — operatör başka bir panel ürünü seçer. Hata (ör. ürün yok/eşleme silinmiş) yüzeye çıkar.
 */
export async function changeMappingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const id = String(formData.get('mappingId') || '').trim();
  const productId = String(formData.get('productId') || '').trim();
  // SEC-1: `id` YOLA gömülüyor (kimlik doğrulaması şart); `productId` gövdeye gider ama
  // kimlik şekli tektir → ikisi de aynı kalıpla kilitlenir.
  if (!isUuid(id) || !isUuid(productId)) {
    return { ok: false, error: 'Geçersiz eşleme veya ürün kimliği — liste yenilenmeli.' };
  }
  const bundleQtyRaw = String(formData.get('bundleQty') || '').trim();
  const bundleQty = bundleQtyRaw ? Number(bundleQtyRaw) : undefined;
  try {
    await apiSend(
      'PATCH',
      `/v1/admin/mappings/${id}`,
      { productId, ...(bundleQty && bundleQty > 0 ? { bundleQty } : {}) },
      await getActor(),
    );
    revalidatePath('/mappings');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/**
 * Eşlemeyi tamamen KALDIR (§3). Sonuç DÖNDÜRÜR (bkz. `MappingMutationState` — denetim C13):
 * eskiden hata yutuluyordu ve DELETE 500 alsa bile operatör hiçbir şey görmüyordu.
 * productId taşınırsa ürün detayını tazeler (ürün-merkezli kutu); yoksa /mappings (katalog ekranı).
 */
export async function removeMappingAction(formData: FormData): Promise<MappingMutationState> {
  const id = String(formData.get('mappingId') || '').trim();
  // SEC-1: kimlik yola gömülüyor → şekli doğrulanmadan istek YAPILMAZ.
  if (!isUuid(id)) {
    return { ok: false, error: 'Geçersiz eşleme kimliği — liste yenilenip tekrar denenmeli.' };
  }
  const productId = String(formData.get('productId') || '').trim();
  let result: MappingMutationState;
  try {
    await apiSend('DELETE', `/v1/admin/mappings/${id}`, undefined, await getActor());
    result = { ok: true };
  } catch (e) {
    // Uç idempotenttir: 404 = kayıt zaten yok ⇒ istenen sonuç sağlanmış, BAŞARI sayılır
    // (`removeMappingWithResult` ile aynı kural — iki ekran çelişmemeli).
    if (e instanceof ApiError && e.status === 404) result = { ok: true };
    else result = { ok: false, error: e instanceof Error ? e.message : 'Eşleme kaldırılamadı' };
  }
  if (productId) revalidatePath(`/products/${productId}`);
  else revalidatePath('/mappings');
  return result;
}

/**
 * Bir sitenin katalog satırlarını getirir (ürün detayı eşleme kutusu için — mağaza ürününü ADIYLA
 * seç, ham ID yazma). Sunucu-taraflı (ADMIN_TOKEN gizli kalır); istemci site seçince çağırır.
 */
export async function fetchSiteCatalogAction(
  siteId: string,
): Promise<{ ok: boolean; rows?: CatalogRow[]; error?: string }> {
  const id = String(siteId || '').trim();
  if (!isUuid(id)) {
    return { ok: false, error: 'Geçersiz site' };
  }
  try {
    const rows = await apiGet<CatalogRow[]>(`/v1/admin/catalog?siteId=${encodeURIComponent(id)}`);
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Katalog alınamadı' };
  }
}
