'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, apiSend } from '../../lib/api';
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
 * Boş kalan opsiyonel alanlar body'ye HİÇ eklenmez → update'te "değişmedi" anlamına gelir.
 */
function buildProductBody(formData: FormData): Record<string, unknown> {
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
  if (validityDays) body.validityDays = validityDays;
  const warrantyDays = num('warrantyDays');
  if (warrantyDays !== undefined) body.warrantyDays = warrantyDays;
  // lowStockThreshold: boş = uyarı KAPALI (body'ye ekleme); 0 dahil geçerli değerdir.
  const lowStockThreshold = num('lowStockThreshold');
  if (lowStockThreshold !== undefined) body.lowStockThreshold = lowStockThreshold;
  // releaseAt: <input type="datetime-local"> → ISO'ya çevir (API .datetime() ister).
  const releaseAt = String(formData.get('releaseAt') || '').trim();
  if (releaseAt) {
    const d = new Date(releaseAt);
    if (!Number.isNaN(d.getTime())) body.releaseAt = d.toISOString();
  }
  const keyFormat = String(formData.get('keyFormat') || '').trim();
  if (keyFormat) body.keyFormat = keyFormat;
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
    await apiSend('PATCH', `/v1/admin/products/${id}`, buildProductBody(formData), await getActor());
    revalidatePath('/stock');
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
    if (!dryRun) revalidatePath('/stock');
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
    return { ok: false, error: 'Site, ürün ve Woo ürün ID zorunlu' };
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
    revalidatePath('/stock');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/** Eşlemeyi pasifleştir/etkinleştir (§3). */
export async function updateMappingAction(formData: FormData) {
  const id = String(formData.get('id') || '');
  const active = String(formData.get('active') || '') === 'true';
  if (!id) return;
  await apiSend('PATCH', `/v1/admin/mappings/${id}`, { active }, await getActor());
  revalidatePath('/stock');
}
