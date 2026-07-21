'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';
import { getActor, isOwner } from '../../lib/session';

export interface ScanState {
  ok: boolean;
  error?: string;
  created?: number;
}

/**
 * Anomali/velocity taramasını elle tetikler (POST /v1/admin/security/scan).
 * Yeni tespitler security_events'e yazılır → {created:n} döner. AUTO-SUSPEND YOK (§15: insan onaylar).
 */
export async function scanSecurityAction(): Promise<ScanState> {
  try {
    const actor = await getActor();
    const { created } = await apiPost<{ created: number }>(
      '/v1/admin/security/scan',
      undefined,
      actor,
    );
    revalidatePath('/security');
    return { ok: true, created };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Tarama başarısız' };
  }
}

export interface AnonymizeState {
  ok: boolean;
  error?: string;
  anonymizedOrders?: number;
  anonymizedReplacements?: number;
}

/**
 * KVKK anonimleştirme (§9) — TEK YÖNLÜ. Verilen e-postanın PII'ı tüm siparişler +
 * değişim taleplerinde 'anon-<hash>@redacted.invalid' ile maskelenir; customers satırı silinir.
 * Sipariş/atama bütünlüğü korunur (kayıt silinmez), audit_log'a yazılır.
 */
export async function anonymizeCustomerAction(email: string): Promise<AnonymizeState> {
  // RBAC (§8): KVKK PII imhası geri alınamaz → yalnız owner.
  if (!(await isOwner())) return { ok: false, error: 'Bu işlem için owner yetkisi gerekir.' };
  const trimmed = email.trim();
  if (!trimmed) return { ok: false, error: 'E-posta zorunlu' };
  try {
    const actor = await getActor();
    const res = await apiPost<{ anonymizedOrders: number; anonymizedReplacements: number }>(
      '/v1/admin/compliance/anonymize',
      { email: trimmed },
      actor,
    );
    revalidatePath('/security');
    return {
      ok: true,
      anonymizedOrders: res.anonymizedOrders,
      anonymizedReplacements: res.anonymizedReplacements,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Anonimleştirme başarısız' };
  }
}
