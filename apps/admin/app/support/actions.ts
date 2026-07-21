'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';
import { getActor } from '../../lib/session';

export interface ActionState {
  ok: boolean;
  error?: string;
}

/**
 * Talebi onayla → DEĞİŞİM: eskiyi geri al + yenisini ata (API atomik makineyi kullanır).
 * Stok yoksa API 409 döner; burada hata olarak yüzeye çıkar, talep 'approved' OLMAZ.
 */
export async function approveReplacementAction(id: string, actor?: string): Promise<ActionState> {
  if (!id) return { ok: false, error: 'Talep id zorunlu' };
  try {
    await apiPost(`/v1/admin/replacements/${id}/approve`, actor ? { actor } : {}, await getActor());
    revalidatePath('/support');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Onaylanamadı' };
  }
}

/** Talebi reddet — not zorunlu (resolutionNote). */
export async function rejectReplacementAction(
  id: string,
  note: string,
  actor?: string,
): Promise<ActionState> {
  if (!id) return { ok: false, error: 'Talep id zorunlu' };
  if (!note.trim()) return { ok: false, error: 'Not zorunlu' };
  try {
    await apiPost(
      `/v1/admin/replacements/${id}/reject`,
      { note: note.trim(), ...(actor ? { actor } : {}) },
      await getActor(),
    );
    revalidatePath('/support');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Reddedilemedi' };
  }
}

/** Talep için müşteriden bilgi iste — not zorunlu (resolutionNote). */
export async function requestInfoReplacementAction(
  id: string,
  note: string,
  actor?: string,
): Promise<ActionState> {
  if (!id) return { ok: false, error: 'Talep id zorunlu' };
  if (!note.trim()) return { ok: false, error: 'Not zorunlu' };
  try {
    await apiPost(
      `/v1/admin/replacements/${id}/request-info`,
      {
        note: note.trim(),
        ...(actor ? { actor } : {}),
      },
      await getActor(),
    );
    revalidatePath('/support');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İşlenemedi' };
  }
}
