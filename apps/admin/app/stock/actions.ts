'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';

export interface ImportState {
  ok: boolean;
  error?: string;
  result?: { requested: number; imported: number; duplicates: number; autoCompleted: number };
}

export async function createProductAction(formData: FormData) {
  await apiPost('/v1/admin/products', {
    sku: String(formData.get('sku') || '').trim(),
    name: String(formData.get('name') || '').trim(),
    kind: String(formData.get('kind') || 'key'),
    usageMode: String(formData.get('usageMode') || 'single'),
    fulfillmentPolicy: String(formData.get('fulfillmentPolicy') || 'partial-auto'),
  });
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
