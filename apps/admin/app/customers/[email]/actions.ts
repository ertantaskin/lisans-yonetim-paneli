'use server';
import { revalidatePath } from 'next/cache';
import { apiSend } from '../../../lib/api';

/**
 * SEC-1 — YOL ENJEKSİYONU: müşteri kimliği UUID DEĞİL, e-postadır → burada UUID kalıbı
 * kullanılamaz. Bunun yerine e-posta ŞEKLİ zorlanır: tek `@`, boşluk/kontrol karakteri yok,
 * `/`, `?`, `#`, `\` ve `..` yok. Sunucu aksiyonları TS tiplerini ÇALIŞMA ANINDA zorlamaz
 * (uç dışarıdan serileştirilmiş argümanla çağrılabilir) ve `encodeURIComponent` tek başına
 * "bu değer gerçekten bir e-posta mı" sorusunu yanıtlamaz. `lib/api` merkezî kapısı ikinci
 * savunma hattıdır. Kasıtlı olarak GEVŞEK: RFC doğrulaması DEĞİL, yalnız yol güvenliği.
 */
const EMAIL_PATH_RE = /^[^\s/?#\\@]+@[^\s/?#\\@]+$/;

export interface UpdateCustomerState {
  ok: boolean;
  error?: string;
  saved?: boolean;
}

/**
 * Müşteri etiket/not güncelle (PATCH /v1/admin/customers/:email). E-posta gizli
 * alandan gelir; etiketler virgülle ayrık metinden diziye çevrilir (boşlar atılır).
 */
export async function updateCustomerAction(
  _prev: UpdateCustomerState,
  formData: FormData,
): Promise<UpdateCustomerState> {
  const email = String(formData.get('email') || '').trim();
  if (!email) return { ok: false, error: 'E-posta zorunlu' };
  if (!EMAIL_PATH_RE.test(email)) return { ok: false, error: 'Geçersiz e-posta adresi.' };

  const tags = String(formData.get('tags') || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const notes = String(formData.get('notes') || '');

  try {
    await apiSend('PATCH', `/v1/admin/customers/${encodeURIComponent(email)}`, {
      tags,
      notes,
    });
    revalidatePath(`/customers/${encodeURIComponent(email)}`);
    revalidatePath('/customers');
    return { ok: true, saved: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}
