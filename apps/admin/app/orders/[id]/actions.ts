'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, type RevealResult } from '../../../lib/api';
import { getActor, isOwner } from '../../../lib/session';

export interface RevealState {
  assignmentId?: string;
  result?: RevealResult;
  error?: string;
}

/**
 * Loglu reveal (§17): atamanın tam payload'ını/alanlarını getirir (audit'e düşer).
 * §3 RBAC: tam düz metin sır → YALNIZ owner. AssignmentLicenseCell useActionState ile
 * bağlar; FormData imzası korunur.
 */
export async function revealAction(_prev: RevealState, formData: FormData): Promise<RevealState> {
  const assignmentId = String(formData.get('assignmentId'));
  if (!(await isOwner())) {
    return { assignmentId, error: 'Düz metni göstermek için yalnız owner yetkili.' };
  }
  try {
    const actor = await getActor();
    const result = await apiPost<RevealResult>(
      `/v1/admin/assignments/${assignmentId}/reveal`,
      undefined,
      actor,
    );
    return { assignmentId, result };
  } catch (e) {
    return { assignmentId, error: e instanceof Error ? e.message : 'Reveal başarısız' };
  }
}

/**
 * Mutasyon aksiyonlarının ortak dönüş tipi. Server action ASLA fırlatmaz (fırlatırsa
 * kök error boundary tüm sayfayı siler + geri-dönüşsüz revoke sessizce çöker, §5/§18);
 * hata ok=false + Türkçe mesaj olarak istemciye döner, inline yüzeye çıkar.
 */
export interface MutationState {
  ok: boolean;
  error?: string;
  message?: string;
}

/**
 * "Kalanları Ata" — satırın kalan adedini atar (§13). Backend added=0 ile SESSİZ no-op dönebilir
 * (stok yok / satır iptal-iade / sipariş incelemede / all-or-nothing eksik / ön-sipariş) — bu
 * durumları yeşil "başarılı" gibi göstermeyip operatöre dürüst bir uyarı veririz (denetim bulgusu).
 */
export async function completeLineAction(lineId: string, orderId: string): Promise<MutationState> {
  if (!lineId || !orderId) return { ok: false, error: 'Geçersiz istek' };
  try {
    const actor = await getActor();
    const res = await apiPost<{ added?: number }>(
      `/v1/admin/fulfillments/${lineId}/complete`,
      undefined,
      actor,
    );
    revalidatePath(`/orders/${orderId}`);
    const added = typeof res?.added === 'number' ? res.added : null;
    if (added === 0) {
      return {
        ok: false,
        error:
          'Atanacak bir şey yok — stok tükenmiş, satır iptal/iade edilmiş ya da sipariş incelemede olabilir.',
      };
    }
    return { ok: true, message: added != null ? `${added} lisans atandı.` : 'Kalanlar atandı.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Atama başarısız' };
  }
}

/** Atamayı iptal et (iade) — key karantinaya, müşteri görünümünden düşer (§2). Geri alınamaz. */
export async function revokeAction(
  assignmentId: string,
  orderId: string,
  reason?: string,
): Promise<MutationState> {
  if (!assignmentId || !orderId) return { ok: false, error: 'Geçersiz istek' };
  try {
    const actor = await getActor();
    await apiPost(
      `/v1/admin/assignments/${assignmentId}/revoke`,
      { reason: reason?.trim() || 'admin iptali' },
      actor,
    );
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Atama iptal edildi.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İptal başarısız' };
  }
}

/**
 * Proaktif değişim (§4): kusurlu key'i aynı üründen TAZE key ile değiştirir — müşteri
 * "Sorun Bildir" açmadan. Eski key karantinaya gider, satır 'canceled' işaretlenmez
 * (iade DEĞİL). reason zorunlu. Stok yoksa API 409 → mesaj yüzeye çıkar (eski atama korunur).
 */
export async function replaceAction(
  assignmentId: string,
  orderId: string,
  reason: string,
): Promise<MutationState> {
  if (!assignmentId || !orderId) return { ok: false, error: 'Geçersiz istek' };
  if (!reason?.trim()) return { ok: false, error: 'Değişim sebebi zorunlu.' };
  try {
    const actor = await getActor();
    await apiPost(
      `/v1/admin/assignments/${assignmentId}/replace`,
      { reason: reason.trim() },
      actor,
    );
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Key değiştirildi — taze key atandı, eski karantinada.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Değişim başarısız' };
  }
}

/**
 * Teslimat mailini yeniden gönder (§13/§17). API'de 60sn debounce var; çok sık denemede
 * 400 döner → kullanıcıya "çok sık" olarak yüzeye çıkarılır (artık sessiz değil).
 */
export async function resendAction(orderId: string): Promise<MutationState> {
  if (!orderId) return { ok: false, error: 'Geçersiz istek' };
  try {
    const actor = await getActor();
    await apiPost(`/v1/admin/orders/${orderId}/resend`, undefined, actor);
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Mail yeniden kuyruğa alındı.' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    // 60sn debounce → 400: hata değil, bilgi niteliğinde uyarı.
    if (/→\s*400\b/.test(msg)) {
      return { ok: false, error: 'Çok sık denendi — 60 sn bekleyip tekrar deneyin.' };
    }
    return { ok: false, error: 'Mail gönderilemedi.' };
  }
}

/** Atamayı askıya al — müşteri görünümünde "inceleme altında" (§4, geri alınabilir). */
export async function suspendAction(
  assignmentId: string,
  orderId: string,
): Promise<MutationState> {
  if (!assignmentId || !orderId) return { ok: false, error: 'Geçersiz istek' };
  try {
    const actor = await getActor();
    await apiPost(`/v1/admin/assignments/${assignmentId}/suspend`, undefined, actor);
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Atama askıya alındı.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Askıya alma başarısız' };
  }
}

/** Askıdan çıkar — atama tekrar aktif ve müşteriye görünür olur. */
export async function unsuspendAction(
  assignmentId: string,
  orderId: string,
): Promise<MutationState> {
  if (!assignmentId || !orderId) return { ok: false, error: 'Geçersiz istek' };
  try {
    const actor = await getActor();
    await apiPost(`/v1/admin/assignments/${assignmentId}/unsuspend`, undefined, actor);
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Atama aktifleştirildi.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İşlem başarısız' };
  }
}

/**
 * Değişim talebini SİPARİŞ ekranından onayla (§13): eskiyi geri al + taze key ata. API atomik
 * makineyi kullanır; MAK/stok-yok → 409 (mesaj yüzeye çıkar, talep 'approved' olmaz). Hem sipariş
 * hem /support yeniden doğrulanır → değişim her iki ekranda anında yansır (kullanıcı isteği).
 */
export async function approveReplacementForOrderAction(
  replacementId: string,
  orderId: string,
): Promise<MutationState> {
  if (!replacementId || !orderId) return { ok: false, error: 'Geçersiz istek' };
  try {
    const actor = await getActor();
    await apiPost(`/v1/admin/replacements/${replacementId}/approve`, {}, actor);
    revalidatePath(`/orders/${orderId}`);
    revalidatePath('/support');
    return { ok: true, message: 'Değişim onaylandı — taze key atandı.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Onaylanamadı' };
  }
}

/** Değişim talebini sipariş ekranından reddet — not zorunlu (müşteriye bildirilir). */
export async function rejectReplacementForOrderAction(
  replacementId: string,
  orderId: string,
  note: string,
): Promise<MutationState> {
  if (!replacementId || !orderId) return { ok: false, error: 'Geçersiz istek' };
  if (!note?.trim()) return { ok: false, error: 'Red gerekçesi zorunlu.' };
  try {
    const actor = await getActor();
    await apiPost(`/v1/admin/replacements/${replacementId}/reject`, { note: note.trim() }, actor);
    revalidatePath(`/orders/${orderId}`);
    revalidatePath('/support');
    return { ok: true, message: 'Talep reddedildi.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Reddedilemedi' };
  }
}
