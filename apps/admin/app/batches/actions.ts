'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';

export interface ActionState {
  ok: boolean;
  error?: string;
}

/** Recall sonucu — void edilen satılmamış adet + değişim gerektiren satılmış adet. */
export interface RecallResult extends ActionState {
  voided?: number;
  soldNeedingReplacement?: number;
}

/**
 * Partiyi geri çek (recall) — sebep zorunlu (sebepsiz değişiklik imkânsız, §12).
 * API: batch.status='recalled'; satılmamış (available) license_items iptal statüsüne çekilir
 * + stock_adjustments('recall') + audit_log. Satılmış adet değişim gerektirir (uyarı döner).
 */
export async function recallBatchAction(id: string, reason: string): Promise<RecallResult> {
  if (!id) return { ok: false, error: 'Parti id zorunlu' };
  if (!reason.trim()) return { ok: false, error: 'Sebep zorunlu' };
  try {
    const res = await apiPost<{ voided: number; soldNeedingReplacement: number }>(
      `/v1/admin/batches/${id}/recall`,
      { reason: reason.trim() },
    );
    revalidatePath('/batches');
    return {
      ok: true,
      voided: res.voided,
      soldNeedingReplacement: res.soldNeedingReplacement,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Geri çekilemedi' };
  }
}
