'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, apiSend, isUuid } from '../../lib/api';
import { isOwner } from '../../lib/session';

/**
 * SEC-1 — YOL ENJEKSİYONU: `id` doğrudan API YOLUNA gömülüyor ve sunucu aksiyonları TS
 * tiplerini ÇALIŞMA ANINDA zorlamaz (action uç noktası dışarıdan, serileştirilmiş
 * argümanlarla çağrılabilir). Kimlik UUID kalıbına bağlanır; `lib/api` merkezî kapısı
 * ikinci savunma hattıdır. Bu uçlar owner-only olduğu için kimliğin şekli de kilitlenir.
 */

/**
 * Admin işlemlerinin ORTAK sonucu.
 *
 * NEDEN (denetim bulgusu, orta): `toggle/reset/delete` action'ları `Promise<void>` döndürüyor,
 * hatayı yutuyor ve çağıran `await` bile etmiyordu. Pasifleştirme/silme en azından tabloda
 * GÖRÜLÜR bir yan etki bırakır (rozet değişir, satır kaybolur) ama PAROLA SIFIRLAMA hiçbir iz
 * bırakmaz → istek 500 alsa da, parola 8 karakterden kısa olduğu için hiç gönderilmese de
 * operatör "değişti" sanıp yeni parolayı kullanıcıya iletiyordu. Üç action da aynı
 * `{ ok, error }` sözleşmesine hizalandı; çağıran sonucu bekler ve toast ile gösterir.
 */
export interface AdminActionState {
  ok?: boolean;
  error?: string;
}

/** Geriye dönük ad (create formu `useActionState` durumu olarak bu adı içe aktarıyor). */
export type CreateAdminState = AdminActionState;

/**
 * API hatasını operatör diline çevirir. 400'ün ANLAMI çağrıya göre değişir (oluşturmada
 * "parola kısa", pasifleştirme/silmede "son aktif yönetici korunuyor") → mesaj parametre.
 */
function friendlyError(
  e: unknown,
  badRequest = 'Geçersiz bilgi (parola en az 8 karakter olmalı).',
): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('409')) return 'Bu e-posta veya kullanıcı adı zaten kayıtlı.';
  if (msg.includes('400')) return badRequest;
  if (msg.includes('403')) return 'Bu işlem için owner yetkisi gerekir.';
  if (msg.includes('404')) return 'Yönetici bulunamadı (silinmiş olabilir).';
  return 'İşlem başarısız. Tekrar deneyin.';
}

/** Yeni admin oluştur. */
export async function createAdminAction(
  _prev: CreateAdminState,
  formData: FormData,
): Promise<CreateAdminState> {
  if (!(await isOwner())) return { error: 'Bu işlem için owner yetkisi gerekir.' };
  const email = String(formData.get('email') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const role = String(formData.get('role') ?? 'admin');
  if (!email || !name || !password) return { error: 'E-posta, ad ve parola zorunlu.' };
  try {
    await apiPost('/v1/admin/users', {
      email,
      name,
      password,
      role: role === 'owner' ? 'owner' : 'admin',
      ...(username ? { username } : {}),
    });
  } catch (e) {
    return { error: friendlyError(e) };
  }
  revalidatePath('/admins');
  return { ok: true };
}

/**
 * Admini pasifleştir/aktifleştir. Son aktif admin korumasında API 400 döner — bu artık
 * SESSİZ no-op değil, operatöre söylenir (aksi halde "tıkladım ama rozet değişmedi" kalıyordu).
 */
export async function toggleAdminAction(formData: FormData): Promise<AdminActionState> {
  if (!(await isOwner())) return { error: 'Bu işlem için owner yetkisi gerekir.' };
  const id = String(formData.get('id') ?? '').trim();
  if (!isUuid(id)) return { error: 'Yönetici bulunamadı (geçersiz kayıt kimliği).' };
  const disabled = String(formData.get('disabled')) === 'true';
  try {
    await apiSend('PATCH', `/v1/admin/users/${id}`, { disabled });
  } catch (e) {
    return {
      error: friendlyError(
        e,
        'Bu yönetici pasifleştirilemez — panelde en az bir aktif yönetici kalmalı.',
      ),
    };
  }
  revalidatePath('/admins');
  return { ok: true };
}

/**
 * Admin parolasını sıfırla.
 *
 * GÖRÜNMEZ İŞLEM: tabloda hiçbir yan etkisi yok → başarısızlık ancak DÖNDÜRÜLEN hatayla fark
 * edilir. Kısa parola artık sessizce yutulmaz; istek atılmadan AÇIK hata döner (modal 8 karakter
 * kilidi UI tarafında var ama sunucu tarafı tek doğruluk kaynağı olmalı).
 */
export async function resetAdminPasswordAction(formData: FormData): Promise<AdminActionState> {
  if (!(await isOwner())) return { error: 'Bu işlem için owner yetkisi gerekir.' };
  const id = String(formData.get('id') ?? '').trim();
  if (!isUuid(id)) return { error: 'Yönetici bulunamadı (geçersiz kayıt kimliği).' };
  const password = String(formData.get('password') ?? '');
  if (password.length < 8) {
    return { error: 'Parola en az 8 karakter olmalı — parola DEĞİŞTİRİLMEDİ.' };
  }
  try {
    await apiPost(`/v1/admin/users/${id}/password`, { password });
  } catch (e) {
    return { error: friendlyError(e, 'Parola kabul edilmedi (en az 8 karakter olmalı).') };
  }
  revalidatePath('/admins');
  return { ok: true };
}

/** Admini sil. Son aktif admin korumasında (400) artık dürüst hata döner. */
export async function deleteAdminAction(formData: FormData): Promise<AdminActionState> {
  if (!(await isOwner())) return { error: 'Bu işlem için owner yetkisi gerekir.' };
  const id = String(formData.get('id') ?? '').trim();
  if (!isUuid(id)) return { error: 'Yönetici bulunamadı (geçersiz kayıt kimliği).' };
  try {
    await apiSend('DELETE', `/v1/admin/users/${id}`);
  } catch (e) {
    return {
      error: friendlyError(e, 'Bu yönetici silinemez — panelde en az bir aktif yönetici kalmalı.'),
    };
  }
  revalidatePath('/admins');
  return { ok: true };
}
