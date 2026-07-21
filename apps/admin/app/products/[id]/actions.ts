'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../../lib/api';

export interface StockAdjustState {
  ok: boolean;
  error?: string;
  saved?: boolean;
}

export const initialStockAdjustState: StockAdjustState = { ok: false };

const ACTIONS = ['void', 'damage', 'correct', 'recall'] as const;
type AdjustAction = (typeof ACTIONS)[number];

/**
 * Manuel stok düzeltme (§12) — POST /v1/admin/stock-adjustments. Sebep ZORUNLU
 * (sebepsiz değişiklik imkânsız; audit'e düşer). Gövde şekli controller ile birebir:
 * productId + action(void|damage|correct|recall) + qty(≥0) + reason + (ops.) licenseItemId.
 * void/damage'de licenseItemId verilirse o available lisans satırı 'voided' yapılır.
 */
export async function createStockAdjustmentAction(
  _prev: StockAdjustState,
  formData: FormData,
): Promise<StockAdjustState> {
  const productId = String(formData.get('productId') || '').trim();
  if (!productId) return { ok: false, error: 'Ürün id zorunlu' };

  const action = String(formData.get('action') || '') as AdjustAction;
  if (!ACTIONS.includes(action)) return { ok: false, error: 'Geçersiz aksiyon' };

  const reason = String(formData.get('reason') || '').trim();
  if (!reason) return { ok: false, error: 'Sebep zorunlu (audit için)' };

  const qtyRaw = String(formData.get('qty') || '0').trim();
  const qty = Number(qtyRaw);
  if (!Number.isInteger(qty) || qty < 0) return { ok: false, error: 'Adet 0 veya pozitif tam sayı olmalı' };

  const licenseItemId = String(formData.get('licenseItemId') || '').trim();

  const body: {
    productId: string;
    action: AdjustAction;
    qty: number;
    reason: string;
    licenseItemId?: string;
  } = { productId, action, qty, reason };
  if (licenseItemId) body.licenseItemId = licenseItemId;

  try {
    await apiPost('/v1/admin/stock-adjustments', body);
    revalidatePath(`/products/${productId}`);
    return { ok: true, saved: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Düzeltme kaydedilemedi' };
  }
}
