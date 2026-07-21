'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';
import { getActor } from '../../lib/session';

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
    await apiPost(`/v1/admin/ops/replay/${kind}/${id}`, undefined, await getActor());
    revalidatePath('/ops');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Yeniden gönderilemedi' };
  }
}

// ── Bakım tetikleyicileri (elle) ─────────────────────────────────────────────
// Periyodik işler (süre-bitişi taraması · mutabakat denetimi) zaten arka planda
// çalışır; bu action'lar aynı uçları elle tetikler. useActionState imzası
// (prevState, formData) — formData kullanılmaz.

export interface MaintenanceState {
  ok: boolean;
  error?: string;
  /** Başarılı sonucun insan-okur özeti. */
  message?: string;
  /** ok ama dikkat gerektiren sonuç (ör: mutabakat ihlali bulundu). */
  warn?: boolean;
}

/**
 * Süre-bitişi taramasını elle çalıştırır (POST /v1/admin/maintenance/expire).
 * Süresi geçmiş 'hide' atamalarını `expired` yapar (payload artık teslim edilmez).
 */
export async function expireMaintenanceAction(
  _prev: MaintenanceState,
  _formData: FormData,
): Promise<MaintenanceState> {
  try {
    const res = await apiPost<{ expired: number }>(
      '/v1/admin/maintenance/expire',
      undefined,
      await getActor(),
    );
    return { ok: true, message: `${res.expired} süresi geçmiş atama gizlendi (expired).` };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Süre-bitişi taraması çalıştırılamadı',
    };
  }
}

/**
 * Mutabakat/tutarlılık denetimini elle çalıştırır (POST /v1/admin/maintenance/reconcile).
 * DÜZELTME YAPMAZ (§16) — denetlenen kayıt + ihlal sayısını raporlar.
 */
export async function reconcileMaintenanceAction(
  _prev: MaintenanceState,
  _formData: FormData,
): Promise<MaintenanceState> {
  try {
    const res = await apiPost<{ checked: number; violations: unknown[] }>(
      '/v1/admin/maintenance/reconcile',
      undefined,
      await getActor(),
    );
    const count = res.violations.length;
    return {
      ok: true,
      warn: count > 0,
      message:
        count === 0
          ? `${res.checked} kayıt denetlendi — ihlal yok.`
          : `${res.checked} kayıt denetlendi — ${count} ihlal bulundu (kritik loglandı, düzeltme yapılmadı).`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Mutabakat denetimi çalıştırılamadı',
    };
  }
}
