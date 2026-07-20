'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';

export interface CheckLowStockState {
  ok: boolean;
  created?: number;
  error?: string;
}

/**
 * Düşük stok kontrolünü elle tetikler (POST /v1/admin/notifications/check-low-stock).
 * API {created:n} döner; yeni bildirim üretilmişse liste tazelenir.
 */
export async function checkLowStockAction(): Promise<CheckLowStockState> {
  try {
    const res = await apiPost<{ created: number }>('/v1/admin/notifications/check-low-stock');
    revalidatePath('/notifications');
    return { ok: true, created: res.created ?? 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Kontrol çalıştırılamadı' };
  }
}
