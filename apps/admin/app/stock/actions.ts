'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';

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
  };
}

export async function createProductAction(formData: FormData) {
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
  };
  if (usageMode === 'multi') body.maxUses = num('maxUses');
  const validityDays = num('validityDays');
  if (validityDays) body.validityDays = validityDays;
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
  await apiPost('/v1/admin/products', body);
  revalidatePath('/stock');
}

/** Stok import — textarea'daki her satır bir key. */
export async function importStockAction(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const productId = String(formData.get('productId') || '');
  const raw = String(formData.get('keys') || '');
  const items = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((payload) => ({ payload }));
  if (!productId) return { ok: false, error: 'Ürün seçin' };
  if (items.length === 0) return { ok: false, error: 'En az bir key girin' };
  try {
    const result = await apiPost<ImportState['result']>('/v1/admin/stock/import', {
      productId,
      items,
    });
    revalidatePath('/stock');
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

export async function createMappingAction(formData: FormData) {
  await apiPost('/v1/admin/mappings', {
    siteId: String(formData.get('siteId') || ''),
    productId: String(formData.get('productId') || ''),
    remoteProductId: String(formData.get('remoteProductId') || '').trim(),
  });
  revalidatePath('/stock');
}
