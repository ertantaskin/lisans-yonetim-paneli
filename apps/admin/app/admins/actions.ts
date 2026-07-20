'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, apiSend } from '../../lib/api';
import { isOwner } from '../../lib/session';

export interface CreateAdminState {
  ok?: boolean;
  error?: string;
}

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('409')) return 'Bu e-posta veya kullanıcı adı zaten kayıtlı.';
  if (msg.includes('400')) return 'Geçersiz bilgi (parola en az 8 karakter olmalı).';
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

/** Admini pasifleştir/aktifleştir. Son aktif admin korumasında (400) sessizce no-op. */
export async function toggleAdminAction(formData: FormData): Promise<void> {
  if (!(await isOwner())) return;
  const id = String(formData.get('id'));
  const disabled = String(formData.get('disabled')) === 'true';
  try {
    await apiSend('PATCH', `/v1/admin/users/${id}`, { disabled });
  } catch {
    // son aktif admin korunuyor / geçici hata — UI çökmesin, durumu yenile
  }
  revalidatePath('/admins');
}

/** Admin parolasını sıfırla. */
export async function resetAdminPasswordAction(formData: FormData): Promise<void> {
  if (!(await isOwner())) return;
  const id = String(formData.get('id'));
  const password = String(formData.get('password') ?? '');
  if (password.length >= 8) {
    try {
      await apiPost(`/v1/admin/users/${id}/password`, { password });
    } catch {
      /* yut — UI çökmesin */
    }
  }
  revalidatePath('/admins');
}

/** Admini sil. Son aktif admin korumasında (400) sessizce no-op. */
export async function deleteAdminAction(formData: FormData): Promise<void> {
  if (!(await isOwner())) return;
  const id = String(formData.get('id'));
  try {
    await apiSend('DELETE', `/v1/admin/users/${id}`);
  } catch {
    // son aktif admin silinemez / geçici hata — UI çökmesin
  }
  revalidatePath('/admins');
}
