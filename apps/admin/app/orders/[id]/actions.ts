'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, type RevealResult } from '../../../lib/api';

export interface RevealState {
  assignmentId?: string;
  result?: RevealResult;
  error?: string;
}

/** Loglu reveal (§17): atamanın tam payload'ını/alanlarını getirir (audit'e düşer). */
export async function revealAction(_prev: RevealState, formData: FormData): Promise<RevealState> {
  const assignmentId = String(formData.get('assignmentId'));
  try {
    const result = await apiPost<RevealResult>(`/v1/admin/assignments/${assignmentId}/reveal`);
    return { assignmentId, result };
  } catch (e) {
    return { assignmentId, error: e instanceof Error ? e.message : 'Reveal başarısız' };
  }
}

/** "Kalanları Ata" — satırın kalan adedini atar (§13). */
export async function completeLineAction(formData: FormData) {
  const lineId = String(formData.get('lineId'));
  const orderId = String(formData.get('orderId'));
  await apiPost(`/v1/admin/fulfillments/${lineId}/complete`);
  revalidatePath(`/orders/${orderId}`);
}

/** Atamayı iptal et (iade) — key karantinaya, müşteri görünümünden düşer (§2). */
export async function revokeAction(formData: FormData) {
  const assignmentId = String(formData.get('assignmentId'));
  const orderId = String(formData.get('orderId'));
  const reason = String(formData.get('reason') || 'admin iptali');
  await apiPost(`/v1/admin/assignments/${assignmentId}/revoke`, { reason });
  revalidatePath(`/orders/${orderId}`);
}

/**
 * Teslimat mailini yeniden gönder (§13). API'de 60sn debounce var; çok sık
 * denemede 400 döner — hata sessiz yutulur, sayfa yine tazelenir (mail listesi güncel).
 */
export async function resendAction(formData: FormData) {
  const orderId = String(formData.get('orderId'));
  try {
    await apiPost(`/v1/admin/orders/${orderId}/resend`);
  } catch {
    // 60sn debounce (400) veya geçici hata — aksiyon ekranını bozma.
  }
  revalidatePath(`/orders/${orderId}`);
}

/** Atamayı askıya al — müşteri görünümünde "inceleme altında" (§4, geri alınabilir). */
export async function suspendAction(formData: FormData) {
  const assignmentId = String(formData.get('assignmentId'));
  const orderId = String(formData.get('orderId'));
  await apiPost(`/v1/admin/assignments/${assignmentId}/suspend`);
  revalidatePath(`/orders/${orderId}`);
}

/** Askıdan çıkar — atama tekrar aktif ve müşteriye görünür olur. */
export async function unsuspendAction(formData: FormData) {
  const assignmentId = String(formData.get('assignmentId'));
  const orderId = String(formData.get('orderId'));
  await apiPost(`/v1/admin/assignments/${assignmentId}/unsuspend`);
  revalidatePath(`/orders/${orderId}`);
}
