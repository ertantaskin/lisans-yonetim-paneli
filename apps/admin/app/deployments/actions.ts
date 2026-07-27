'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, ApiError } from '../../lib/api';
import { getActor, isOwner } from '../../lib/session';

export interface DeployState {
  ok: boolean;
  message: string;
}

const TARGETS = ['api', 'admin', 'api admin'];

/**
 * Panelden prod'a dağıtım İSTEĞİ kaydeder (POST /v1/admin/deployments). Yalnız KAYIT tutar;
 * gerçek `deploy.sh`'ı VPS host'undaki runner çalıştırır (API konteynerine Docker soketi
 * verilmez — güvenlik). Auth AÇIKKEN yalnız owner tetikleyebilir (yüksek yetkili işlem).
 */
export async function requestDeploy(_prev: DeployState, formData: FormData): Promise<DeployState> {
  if (!(await isOwner())) {
    return { ok: false, message: 'Bu işlem yalnız "owner" rolüne açıktır.' };
  }
  const target = String(formData.get('target') ?? '').trim();
  if (!TARGETS.includes(target)) {
    return { ok: false, message: 'Geçersiz dağıtım hedefi.' };
  }
  try {
    const actor = await getActor();
    await apiPost('/v1/admin/deployments', { target }, actor);
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : 'Dağıtım isteği başarısız' };
  }
  revalidatePath('/deployments');
  return {
    ok: true,
    message: `Dağıtım isteği kaydedildi (${target}). Host runner kısa süre içinde çalıştıracak — durumu aşağıdan izleyin.`,
  };
}
