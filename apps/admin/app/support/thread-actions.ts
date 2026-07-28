'use server';
import { revalidatePath } from 'next/cache';
import { apiGet, apiPost } from '../../lib/api';
import { getActor } from '../../lib/session';

// NOT: 'use server' dosyası YALNIZ async fonksiyon export edebilir (Next 15). Sabit/obje
// export EDİLEMEZ — aksi halde tüm action chunk'ı "can only export async functions" ile patlar
// ve sayfadaki HER server action bozulur. Başlangıç durumları istemci bileşeninde tanımlıdır.

/** Destek yazışmasındaki tek mesaj (admin görünümü — iç notlar DAHİL). */
export interface ThreadMessage {
  id: string;
  requestId: string;
  authorType: 'admin' | 'customer' | 'system';
  authorName: string;
  body: string;
  internal: boolean;
  createdAt: string;
}

export interface ThreadState {
  ok: boolean;
  error?: string;
  sent?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Talebin yazışmasını getirir (§13). Sunucu-taraflı → ADMIN_TOKEN tarayıcıya sızmaz.
 * Hata sayfayı KIRMAZ: `{ok:false}` döner, bileşen satır içi uyarı gösterir.
 */
export async function fetchThreadAction(
  requestId: string,
): Promise<{ ok: boolean; messages?: ThreadMessage[]; error?: string }> {
  const id = String(requestId || '').trim();
  if (!UUID_RE.test(id)) return { ok: false, error: 'Geçersiz talep' };
  try {
    const messages = await apiGet<ThreadMessage[]>(`/v1/admin/replacements/${id}/messages`);
    return { ok: true, messages: messages ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Yazışma alınamadı' };
  }
}

/**
 * Talebe cevap yaz (kullanıcı isteği: "cevap verme gibi bir şansımız olmuyor").
 * `internal=true` → yalnız panelde görünen İÇ NOT (müşteriye gitmez, mail tetiklenmez).
 * Mesaj yazmak talebin DURUMUNU değiştirmez (Onayla/Reddet ayrı aksiyonlardır).
 */
export async function sendThreadMessageAction(
  _prev: ThreadState,
  formData: FormData,
): Promise<ThreadState> {
  const id = String(formData.get('requestId') || '').trim();
  const body = String(formData.get('body') || '').trim();
  const internal = String(formData.get('internal') || '') === 'true';
  if (!UUID_RE.test(id)) return { ok: false, error: 'Geçersiz talep' };
  if (!body) return { ok: false, error: 'Mesaj boş olamaz' };
  if (body.length > 4000) return { ok: false, error: 'Mesaj çok uzun (en fazla 4000 karakter)' };

  const orderId = String(formData.get('orderId') || '').trim();
  try {
    await apiPost(`/v1/admin/replacements/${id}/messages`, { body, internal }, await getActor());
    revalidatePath('/support');
    if (UUID_RE.test(orderId)) revalidatePath(`/orders/${orderId}`);
    return { ok: true, sent: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Mesaj gönderilemedi' };
  }
}
