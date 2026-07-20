'use server';
import { revalidatePath } from 'next/cache';
import { apiSend } from '../../../lib/api';

export interface UpdateCustomerState {
  ok: boolean;
  error?: string;
  saved?: boolean;
}

/**
 * Müşteri etiket/not güncelle (PATCH /v1/admin/customers/:email). E-posta gizli
 * alandan gelir; etiketler virgülle ayrık metinden diziye çevrilir (boşlar atılır).
 */
export async function updateCustomerAction(
  _prev: UpdateCustomerState,
  formData: FormData,
): Promise<UpdateCustomerState> {
  const email = String(formData.get('email') || '').trim();
  if (!email) return { ok: false, error: 'E-posta zorunlu' };

  const tags = String(formData.get('tags') || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const notes = String(formData.get('notes') || '');

  try {
    await apiSend('PATCH', `/v1/admin/customers/${encodeURIComponent(email)}`, {
      tags,
      notes,
    });
    revalidatePath(`/customers/${encodeURIComponent(email)}`);
    revalidatePath('/customers');
    return { ok: true, saved: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}
