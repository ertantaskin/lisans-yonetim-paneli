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
    // Dürüst vaat: sayfa aktif dağıtım varken kendini 10 sn'de bir tazeler (auto-refresh.tsx).
    // Eskiden "aşağıdan izleyin" deniyor ama tablo donuk kalıyordu → operatör takıldı sanıp
    // ikinci kez tetikliyor ve 409 alıyordu.
    message: `Dağıtım isteği kaydedildi (${target}). Host runner kısa süre içinde çalıştıracak — aşağıdaki geçmiş tablosu durum değişince kendiliğinden güncellenir (tekrar tetiklemeyin).`,
  };
}

/** Yedek hedefleri (API whitelist'iyle birebir — bkz. deployments.service DEPLOY_TARGETS). */
const BACKUP_TARGETS: Record<string, string> = {
  backup: 'Yedek al',
  'backup-drill': 'Yedek tatbikatı',
};

/**
 * Yedek / tatbikat İSTEĞİ kaydeder (POST /v1/admin/deployments, target=backup|backup-drill).
 *
 * MİMARİ KURAL: panel konteynerinden ASLA `pg_dump`/docker çalıştırılmaz — yalnız kuyruğa
 * bir istek yazılır; VPS host'undaki `scripts/backup-runner.sh` (cron) claim edip
 * `backup-drill.sh`'ı çalıştırır ve sonucu geri yazar. Dağıtımla AYNI kuyruk, AYNI
 * tek-aktif guard'ı, AYNI owner-only kapısı (API'de OwnerGuard ile de zorlanır).
 */
export async function requestBackup(_prev: DeployState, formData: FormData): Promise<DeployState> {
  if (!(await isOwner())) {
    return { ok: false, message: 'Bu işlem yalnız "owner" rolüne açıktır.' };
  }
  const target = String(formData.get('target') ?? '').trim();
  if (!(target in BACKUP_TARGETS)) {
    return { ok: false, message: 'Geçersiz yedek hedefi.' };
  }
  try {
    const actor = await getActor();
    await apiPost('/v1/admin/deployments', { target }, actor);
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : 'Yedek isteği başarısız' };
  }
  revalidatePath('/deployments');
  return {
    ok: true,
    // Dürüst vaat: aktif iş varken sayfa 10 sn'de bir tazelenir (auto-refresh.tsx). Tatbikat
    // dakikalarca sürebilir — "bitti" DEMEYİZ, "durum kendiliğinden güncellenir" deriz.
    message: `${BACKUP_TARGETS[target]} isteği kaydedildi. Host runner kısa süre içinde çalıştıracak — durum aşağıda kendiliğinden güncellenir (tekrar tetiklemeyin).`,
  };
}
