'use server';
import { revalidatePath } from 'next/cache';
import { ApiError, apiPost, isUuid } from '../../lib/api';
import { getSessionUser, isOwner } from '../../lib/session';
import type { AdminActionState } from './actions';

/**
 * İki faktörlü doğrulama (TOTP) sunucu aksiyonları.
 *
 * GÜVENLİK KURALI: "kendi hesabım" işlemlerinde hedef kimlik HER ZAMAN doğrulanmış OTURUMDAN
 * alınır — formdan ASLA. (Sunucu aksiyonu uç noktası dışarıdan, serileştirilmiş argümanlarla
 * çağrılabilir; formdaki id'ye güvenmek bir adminin BAŞKASININ ikinci faktörünü kurmasına/
 * kapatmasına kapı açardı. API tarafında da `assertSelfOrOwner` var — çift savunma.)
 */
export interface TotpSetupState {
  ok?: boolean;
  error?: string;
  /** Kurulum başlatıldığında BİR KEZ gösterilen sır + URI (yalnız kullanıcının kendi ekranı). */
  secret?: string;
  otpauthUri?: string;
  account?: string;
  /** Onay sonrası true → ekran "açık" durumuna geçer. */
  enabled?: boolean;
}

/**
 * API hatasını operatör diline çevirir.
 *
 * DURUM KODUNA/VERİYE BAĞLI (denetim D4): eskiden mesajın `'POST '`/`'GET '` ile BAŞLAYIP
 * başlamadığına bakılıyordu — yani `lib/api`nin generic kalıbı (`POST /path → 401`) metin
 * olarak tanınmaya çalışılıyordu. Kalıp değişse (ya da API mesajı tesadüfen "GET" ile
 * başlasa) operatöre ham teknik metin gösterilirdi. `ApiError.humanMessage` bu ayrımı VERİ
 * olarak taşır: true = API'nin Türkçe gövdesi ya da bizim zaman aşımı metnimiz.
 */
function friendly(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.humanMessage ? e.message : fallback;
  return fallback;
}

/** Oturumdaki adminin kimliği (auth kapalıysa null → aksiyonlar anlamlı çalışamaz). */
async function selfId(): Promise<string | null> {
  const user = await getSessionUser();
  return user?.sub ?? null;
}

/** Kurulumu başlat — sır + otpauth URI'si BİR KEZ döner; TOTP henüz AÇILMAZ. */
export async function startTotpSetupAction(
  _prev: TotpSetupState,
  _formData: FormData,
): Promise<TotpSetupState> {
  const id = await selfId();
  if (!id) return { error: 'Oturum bulunamadı. Yeniden giriş yapın.' };
  try {
    const res = await apiPost<{ secret: string; otpauthUri: string; account: string }>(
      `/v1/admin/users/${id}/totp/setup`,
    );
    return { ok: true, ...res };
  } catch (e) {
    return { error: friendly(e, 'Kurulum başlatılamadı. Tekrar deneyin.') };
  }
}

/** İlk kodu doğrula → TOTP açılır. Bundan sonra giriş iki adımlıdır. */
export async function confirmTotpSetupAction(
  _prev: TotpSetupState,
  formData: FormData,
): Promise<TotpSetupState> {
  const id = await selfId();
  if (!id) return { error: 'Oturum bulunamadı. Yeniden giriş yapın.' };
  const code = String(formData.get('code') ?? '').trim();
  if (!code) return { error: 'Doğrulama kodu zorunlu.' };
  try {
    await apiPost(`/v1/admin/users/${id}/totp/confirm`, { code });
  } catch (e) {
    return { error: friendly(e, 'Kod doğrulanamadı. Telefonunuzun saatini kontrol edin.') };
  }
  revalidatePath('/admins/security');
  revalidatePath('/admins');
  return { ok: true, enabled: true };
}

/** Kendi TOTP'ni kapat — parola + GEÇERLİ KOD şart (çalınmış çerez tek başına sökemesin). */
export async function disableTotpAction(
  _prev: TotpSetupState,
  formData: FormData,
): Promise<TotpSetupState> {
  const id = await selfId();
  if (!id) return { error: 'Oturum bulunamadı. Yeniden giriş yapın.' };
  const password = String(formData.get('password') ?? '');
  const code = String(formData.get('code') ?? '').trim();
  if (!password || !code) return { error: 'Parola ve güncel kod zorunlu.' };
  try {
    await apiPost(`/v1/admin/users/${id}/totp/disable`, { password, code });
  } catch (e) {
    return { error: friendly(e, 'Kapatılamadı: parola veya kod hatalı.') };
  }
  revalidatePath('/admins/security');
  revalidatePath('/admins');
  return { ok: true, enabled: false };
}

/**
 * KURTARMA (owner): cihazını kaybeden kullanıcının TOTP'sini sıfırlar. Hedef kimlik formdan
 * gelir (owner başkası için yapar) → UUID kalıbı + owner kapısı ile korunur. API tarafında
 * OwnerGuard ikinci hattır. Sıfırlama `token_version`'ı artırır → o hesabın açık TÜM
 * oturumları düşer.
 */
export async function resetTotpAction(formData: FormData): Promise<AdminActionState> {
  if (!(await isOwner())) return { error: 'Bu işlem için owner yetkisi gerekir.' };
  const id = String(formData.get('id') ?? '').trim();
  if (!isUuid(id)) return { error: 'Yönetici bulunamadı (geçersiz kayıt kimliği).' };
  try {
    await apiPost(`/v1/admin/users/${id}/totp/reset`);
  } catch (e) {
    return { error: friendly(e, 'Sıfırlanamadı. Tekrar deneyin.') };
  }
  revalidatePath('/admins');
  return { ok: true };
}

/** Owner: başka bir yöneticinin TOTP'sini kapat (kurtarmanın hafif hâli; oturumlar düşmez). */
export async function disableTotpForUserAction(formData: FormData): Promise<AdminActionState> {
  if (!(await isOwner())) return { error: 'Bu işlem için owner yetkisi gerekir.' };
  const id = String(formData.get('id') ?? '').trim();
  if (!isUuid(id)) return { error: 'Yönetici bulunamadı (geçersiz kayıt kimliği).' };
  try {
    await apiPost(`/v1/admin/users/${id}/totp/disable`, {});
  } catch (e) {
    return { error: friendly(e, 'Kapatılamadı. Tekrar deneyin.') };
  }
  revalidatePath('/admins');
  return { ok: true };
}
