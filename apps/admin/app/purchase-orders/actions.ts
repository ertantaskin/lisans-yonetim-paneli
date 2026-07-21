'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, apiSend } from '@/lib/api';
import { getActor } from '@/lib/session';

export interface POFormState {
  ok: boolean;
  error?: string;
  /** Oluşturma başarısında yeni emir id'si (yönlendirme için). */
  id?: string;
}

const initial: POFormState = { ok: false };

/** eta metnini (yyyy-mm-dd) ISO'ya çevirir; boşsa undefined. */
function etaToIso(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Satın alma emri oluştur (§12). status draft veya ordered. */
export async function createPurchaseOrderAction(
  _prev: POFormState,
  formData: FormData,
): Promise<POFormState> {
  const supplierId = String(formData.get('supplierId') || '').trim();
  const productId = String(formData.get('productId') || '').trim();
  const qtyOrdered = Number(formData.get('qtyOrdered'));
  const status = String(formData.get('status') || 'draft').trim();
  if (!supplierId) return { ok: false, error: 'Tedarikçi zorunlu' };
  if (!productId) return { ok: false, error: 'Ürün zorunlu' };
  if (!Number.isInteger(qtyOrdered) || qtyOrdered <= 0)
    return { ok: false, error: 'Sipariş adedi pozitif tam sayı olmalı' };

  const unitCostRaw = String(formData.get('unitCostCents') || '').trim();
  const unitCostCents = unitCostRaw ? Number(unitCostRaw) : undefined;
  if (unitCostCents !== undefined && (!Number.isInteger(unitCostCents) || unitCostCents < 0))
    return { ok: false, error: 'Birim maliyet negatif olamaz (kuruş, tam sayı)' };

  const currency = String(formData.get('currency') || 'TRY').trim() || 'TRY';
  const eta = etaToIso(String(formData.get('eta') || ''));
  const notes = String(formData.get('notes') || '').trim();

  try {
    const po = await apiPost<{ id: string }>(
      '/v1/admin/purchase-orders',
      {
        supplierId,
        productId,
        qtyOrdered,
        status: status === 'ordered' ? 'ordered' : 'draft',
        currency,
        ...(unitCostCents !== undefined ? { unitCostCents } : {}),
        ...(eta ? { eta } : {}),
        ...(notes ? { notes } : {}),
      },
      await getActor(),
    );
    revalidatePath('/purchase-orders');
    return { ok: true, id: po?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/** Emir güncelle (durum/eta/not) — detay sayfasından. */
export async function updatePurchaseOrderAction(
  _prev: POFormState,
  formData: FormData,
): Promise<POFormState> {
  const id = String(formData.get('id') || '').trim();
  if (!id) return { ok: false, error: 'Emir id zorunlu' };
  const status = String(formData.get('status') || '').trim();
  const eta = etaToIso(String(formData.get('eta') || ''));
  const etaRaw = String(formData.get('eta') || '').trim();
  const notes = String(formData.get('notes') || '').trim();
  try {
    await apiSend(
      'PATCH',
      `/v1/admin/purchase-orders/${id}`,
      {
        ...(status ? { status } : {}),
        // eta boş bırakılırsa null'a çek; geçerliyse ISO gönder
        eta: etaRaw ? eta : null,
        notes: notes || null,
      },
      await getActor(),
    );
    revalidatePath(`/purchase-orders/${id}`);
    revalidatePath('/purchase-orders');
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/**
 * Teslim al (§12) — kısmi teslim destekli. qty kadar teslim işaretlenir, YENİ parti
 * satırı (batchLabel) oluşur. Gerçek key stok girişi ayrıdır (stock.import).
 */
export async function receivePurchaseOrderAction(
  _prev: POFormState,
  formData: FormData,
): Promise<POFormState> {
  const id = String(formData.get('id') || '').trim();
  if (!id) return { ok: false, error: 'Emir id zorunlu' };
  const qty = Number(formData.get('qty'));
  if (!Number.isInteger(qty) || qty <= 0)
    return { ok: false, error: 'Teslim adedi pozitif tam sayı olmalı' };
  const batchLabel = String(formData.get('batchLabel') || '').trim();
  if (!batchLabel) return { ok: false, error: 'Parti etiketi zorunlu' };
  const notes = String(formData.get('notes') || '').trim();
  try {
    await apiPost(
      `/v1/admin/purchase-orders/${id}/receive`,
      {
        qty,
        batchLabel,
        ...(notes ? { notes } : {}),
      },
      await getActor(),
    );
    revalidatePath(`/purchase-orders/${id}`);
    revalidatePath('/purchase-orders');
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

export { initial as initialPOFormState };
