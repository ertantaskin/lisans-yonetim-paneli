'use server';
import { revalidatePath } from 'next/cache';
import { apiGet, apiPost, apiSend, type CatalogRow } from '../../lib/api';
import { getActor } from '../../lib/session';

export interface ImportState {
  ok: boolean;
  error?: string;
  result?: {
    requested: number;
    imported: number;
    duplicates: number;
    rejected: number;
    rejections?: Array<{ index: number; reason: string }>;
    autoCompleted: number;
    /** Kuru çalıştırma (§7): true ise hiçbir şey kaydedilmedi (yalnız önizleme). */
    dryRun?: boolean;
    /** Kuru çalıştırma tahmini: dedupe sonrası girilecek satır sayısı. */
    wouldImport?: number;
  };
}

/**
 * Ürün formundaki alanları API body'sine dönüştürür (create + update ortak).
 *
 * `isUpdate=false` (create): boş kalan opsiyonel alanlar body'ye HİÇ eklenmez → DB default null.
 * `isUpdate=true`  (update): opsiyonel alanlar HER ZAMAN gönderilir — değer varsa değer, boşsa
 *   açık `null` → API alanı temizler ("Boş = kapalı" sözü düzenlemede de tutulur; aksi halde eski
 *   değer inatla kalırdı). Nullable alanlar: validityDays/warrantyDays/lowStockThreshold/keyFormat/releaseAt.
 */
function buildProductBody(formData: FormData, isUpdate = false): Record<string, unknown> {
  const kind = String(formData.get('kind') || 'key');
  const usageMode = String(formData.get('usageMode') || 'single');
  const num = (k: string): number | undefined => {
    const v = String(formData.get(k) || '').trim();
    return v ? Number(v) : undefined;
  };

  const body: Record<string, unknown> = {
    sku: String(formData.get('sku') || '').trim(),
    name: String(formData.get('name') || '').trim(),
    kind,
    usageMode,
    fulfillmentPolicy: String(formData.get('fulfillmentPolicy') || 'partial-auto'),
    onExpiry: String(formData.get('onExpiry') || 'hide'),
    // checkbox: işaretliyse 'on', değilse yok → boolean'a normalize et.
    stockless: formData.get('stockless') != null,
  };
  if (usageMode === 'multi') body.maxUses = num('maxUses');

  const validityDays = num('validityDays');
  const warrantyDays = num('warrantyDays');
  const lowStockThreshold = num('lowStockThreshold');
  // releaseAt: <input type="datetime-local"> → ISO'ya çevir (API .datetime() ister).
  const releaseAtRaw = String(formData.get('releaseAt') || '').trim();
  let releaseAtIso: string | undefined;
  if (releaseAtRaw) {
    const d = new Date(releaseAtRaw);
    if (!Number.isNaN(d.getTime())) releaseAtIso = d.toISOString();
  }
  const keyFormat = String(formData.get('keyFormat') || '').trim();

  if (isUpdate) {
    // Update: boş = açık null (temizle); değer varsa gönder. lowStock 0 geçerli değerdir.
    body.validityDays = validityDays ?? null;
    body.warrantyDays = warrantyDays ?? null;
    body.lowStockThreshold = lowStockThreshold ?? null;
    body.releaseAt = releaseAtIso ?? null;
    body.keyFormat = keyFormat || null;
  } else {
    // Create: boş = atla (DB default null). Davranış create'te değişmedi.
    if (validityDays) body.validityDays = validityDays;
    if (warrantyDays !== undefined) body.warrantyDays = warrantyDays;
    // lowStockThreshold: boş = uyarı KAPALI (body'ye ekleme); 0 dahil geçerli değerdir.
    if (lowStockThreshold !== undefined) body.lowStockThreshold = lowStockThreshold;
    if (releaseAtIso) body.releaseAt = releaseAtIso;
    if (keyFormat) body.keyFormat = keyFormat;
  }
  // account: payloadSchema client'ta JSON'a serialize edilmiş — parse edip iletiriz.
  if (kind === 'account') {
    const raw = String(formData.get('payloadSchema') || '');
    if (raw) {
      try {
        body.payloadSchema = JSON.parse(raw);
      } catch {
        /* boş bırak — API refine reddeder, kullanıcı düzeltir */
      }
    }
  }
  return body;
}

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
  if (!id) return { ok: false, error: 'Ürün ID eksik' };
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

/** Stok import — textarea'daki her satır bir key. */
export async function importStockAction(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const productId = String(formData.get('productId') || '');
  const batchId = String(formData.get('batchId') || '').trim();
  // Kuru çalıştırma (§7): "Kuru Çalıştır" butonu name=dryRun value=true gönderir.
  const dryRun = String(formData.get('dryRun') || '') === 'true';
  const raw = String(formData.get('keys') || '');
  const items = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((payload) => ({ payload }));
  if (!productId) return { ok: false, error: 'Ürün seçin' };
  if (items.length === 0) return { ok: false, error: 'En az bir key girin' };
  try {
    const result = await apiPost<ImportState['result']>(
      '/v1/admin/stock/import',
      {
        productId,
        items,
        // Boşsa gönderme — API opsiyonel uuid bekler (boş string uuid doğrulamasını bozar).
        ...(batchId ? { batchId } : {}),
        // Kuru çalıştırmada yalnız true gönder; gerçek import'ta bayrağı hiç ekleme.
        ...(dryRun ? { dryRun: true } : {}),
      },
      await getActor(),
    );
    // Kuru çalıştırma DB'yi değiştirmez → cache invalidation gereksiz; yalnız gerçek import'ta.
    // Import artık ürün detayında yapılıyor → o sayfayı tazele (+ /stock stok kolonu için).
    if (!dryRun) {
      revalidatePath(`/products/${productId}`);
      revalidatePath('/stock');
    }
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

export interface PreviewState {
  ok: boolean;
  error?: string;
  result?: {
    count: number;
    pendingLines: number;
    pendingUnits: number;
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
    const result = await apiPost<PreviewState['result']>('/v1/admin/stock/preview', {
      productId,
      count: Math.max(0, Math.floor(count)),
    });
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

/** Eşlemeyi pasifleştir/etkinleştir (§3). productId ürün detayını tazelemek için (opsiyonel). */
export async function updateMappingAction(formData: FormData) {
  const id = String(formData.get('id') || '');
  const active = String(formData.get('active') || '') === 'true';
  const productId = String(formData.get('productId') || '').trim();
  if (!id) return;
  try {
    await apiSend('PATCH', `/v1/admin/mappings/${id}`, { active }, await getActor());
  } catch {
    // Eşleme eşzamanlı silinmiş / API 500 dönmüş olabilir — throw'u YUT ki yakalanmamış
    // hata tüm sayfayı Next error boundary'sine düşürüp boşaltmasın (kardeş action'lar da
    // hata yutar). revalidate UI'ı gerçek duruma tazeler.
  }
  // Toggle formu productId taşıyorsa ürün detayını tazele; yoksa (geriye dönük) /stock.
  if (productId) revalidatePath(`/products/${productId}`);
  else revalidatePath('/stock');
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
  if (!id || !productId) return { ok: false, error: 'Eşleme ve yeni ürün zorunlu' };
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

/** Eşlemeyi tamamen KALDIR (§3). Basit form action; hata yutulur (kardeş action deseni), revalidate tazeler.
 *  productId taşınırsa ürün detayını tazeler (ürün-merkezli kutu); yoksa /mappings (katalog ekranı). */
export async function removeMappingAction(formData: FormData) {
  const id = String(formData.get('mappingId') || '').trim();
  if (!id) return;
  const productId = String(formData.get('productId') || '').trim();
  try {
    await apiSend('DELETE', `/v1/admin/mappings/${id}`, undefined, await getActor());
  } catch {
    // Eşleme zaten silinmiş / 404 olabilir — yut; revalidate UI'ı gerçek duruma tazeler.
  }
  if (productId) revalidatePath(`/products/${productId}`);
  else revalidatePath('/mappings');
}

/**
 * Bir sitenin katalog satırlarını getirir (ürün detayı eşleme kutusu için — mağaza ürününü ADIYLA
 * seç, ham ID yazma). Sunucu-taraflı (ADMIN_TOKEN gizli kalır); istemci site seçince çağırır.
 */
export async function fetchSiteCatalogAction(
  siteId: string,
): Promise<{ ok: boolean; rows?: CatalogRow[]; error?: string }> {
  const id = String(siteId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, error: 'Geçersiz site' };
  }
  try {
    const rows = await apiGet<CatalogRow[]>(`/v1/admin/catalog?siteId=${encodeURIComponent(id)}`);
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Katalog alınamadı' };
  }
}
