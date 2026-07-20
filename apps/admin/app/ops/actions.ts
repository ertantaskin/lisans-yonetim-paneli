'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';

export interface ReplayState {
  ok: boolean;
  error?: string;
}

/**
 * Dead-letter kaydını yeniden kuyruğa alır (POST /v1/admin/ops/replay/:kind/:id).
 * Başarılıysa liste tazelenir (durum pending/queued'e döner).
 */
export async function replayAction(kind: 'outbox' | 'email', id: string): Promise<ReplayState> {
  try {
    await apiPost(`/v1/admin/ops/replay/${kind}/${id}`);
    revalidatePath('/ops');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Yeniden gönderilemedi' };
  }
}
