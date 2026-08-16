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

/**
 * Anonimleştirme sayaçları (API `AnonymizeResult` ile BİREBİR — apps/api/src/security/
 * compliance.service.ts). Uç YEDİ alan döndürüyor; panel yalnız İKİSİNİ okuyordu.
 *
 * NEDEN ÖNEMLİ: siparişi olmayan ama destek yazışması / güvenlik olayı / kayıtlı görünüm
 * kaydı bulunan bir müşteride ekran "0 sipariş, 0 talep maskelendi" diyordu → operatör
 * işlemin ÇALIŞMADIĞINI sanıp tekrar deniyordu (oysa PII gerçekten maskelenmişti).
 *
 * Alanlar OPSİYONEL: eski API imajı yalnız ilk ikisini döndürebilir → rapor o satırları atlar.
 */
export interface AnonymizeCounts {
  anonymizedOrders?: number;
  anonymizedReplacements?: number;
  anonymizedEmails?: number;
  anonymizedSecurityEvents?: number;
  anonymizedMessages?: number;
  anonymizedSavedViews?: number;
  /** Kayıtlarda yerine yazılan takma e-posta (`anon-<hash>@redacted.invalid`). */
  redactedEmail?: string;
}

export interface AnonymizeState extends AnonymizeCounts {
  ok: boolean;
  error?: string;
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
    const res = await apiPost<AnonymizeCounts>(
      '/v1/admin/compliance/anonymize',
      { email: trimmed },
      actor,
    );
    revalidatePath('/security');
    // TÜM sayaçlar taşınır (eskiden 2/7 okunuyordu). Alan gelmezse `undefined` kalır ve
    // rapor o satırı hiç yazmaz — "0" yazmak "bu kasa taranmadı"yı gizlerdi.
    return {
      ok: true,
      anonymizedOrders: res.anonymizedOrders,
      anonymizedReplacements: res.anonymizedReplacements,
      anonymizedEmails: res.anonymizedEmails,
      anonymizedSecurityEvents: res.anonymizedSecurityEvents,
      anonymizedMessages: res.anonymizedMessages,
      anonymizedSavedViews: res.anonymizedSavedViews,
      redactedEmail: res.redactedEmail,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Anonimleştirme başarısız' };
  }
}
