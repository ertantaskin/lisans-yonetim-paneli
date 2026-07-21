'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';
import { getActor } from '../../lib/session';

export interface ActionState {
  ok: boolean;
  error?: string;
}

/**
 * Onayla → hold kaldırılır ve teslimat çalışır (API fulfillment). Body YOK.
 * POST /v1/admin/orders/:id/release — audit'e düşer (actor).
 */
export async function releaseAction(orderId: string): Promise<ActionState> {
  if (!orderId) return { ok: false, error: 'Sipariş id zorunlu' };
  try {
    await apiPost(`/v1/admin/orders/${orderId}/release`, undefined, await getActor());
    revalidatePath('/review');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Onaylanamadı' };
  }
}

/**
 * Reddet → sipariş kapatılır, müşteriye key GİTMEZ. Sebep zorunlu (min 1).
 * POST /v1/admin/orders/:id/reject body { reason } — audit'e düşer (actor).
 */
export async function rejectAction(orderId: string, reason: string): Promise<ActionState> {
  if (!orderId) return { ok: false, error: 'Sipariş id zorunlu' };
  if (!reason.trim()) return { ok: false, error: 'Sebep zorunlu' };
  try {
    await apiPost(`/v1/admin/orders/${orderId}/reject`, { reason: reason.trim() }, await getActor());
    revalidatePath('/review');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Reddedilemedi' };
  }
}
