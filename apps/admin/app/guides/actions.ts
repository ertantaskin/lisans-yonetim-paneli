'use server';
import { revalidatePath } from 'next/cache';
import { GUIDE_BODY_MAX } from '@lisans/shared';
import { apiPost, apiSend, isUuid } from '@/lib/api';
import { getActor } from '@/lib/session';

/**
 * DİKKAT: 'use server' modülü — YALNIZ `export async function` ve `export type/interface`
 * bulunabilir. Obje export'u Next 15'te ÇALIŞMA ANINDA tüm action chunk'ını patlatır
 * (`next build` bunu YAKALAMAZ; bkz. commit 9b81c9b / ee59e14 ve scripts/check-use-server.js).
 *
 * SEC-1 — YOL ENJEKSİYONU: rehber kimliği doğrudan API yoluna gömülür ve sunucu aksiyonları
 * TS tiplerini çalışma anında zorlamaz → kimlik UUID kalıbına bağlanır (isUuid).
 */
export interface GuideFormState {
  ok: boolean;
  error?: string;
  message?: string;
}

/**
 * Rehber ekranı ile ürün ekranları AYNI veriyi gösterir (ürün formundaki açılır liste,
 * ürün listesindeki "rehber" kolonu) → birlikte tazelenir. Teslimat yüzeyleri (mağaza
 * sayfası / mail) rehberi HER İSTEKTE panelden okur, önbelleklenmez: bir adımı düzeltmek
 * anında geçerli olur.
 */
async function revalidateGuideScreens() {
  revalidatePath('/guides');
  revalidatePath('/stock');
}

export async function createGuideAction(
  _prev: GuideFormState,
  formData: FormData,
): Promise<GuideFormState> {
  const title = String(formData.get('title') || '').trim();
  const body = String(formData.get('body') || '').trim();
  if (!title) return { ok: false, error: 'Rehber başlığı zorunlu' };
  if (!body) return { ok: false, error: 'Rehber metni zorunlu' };
  if (body.length > GUIDE_BODY_MAX) {
    return { ok: false, error: `Rehber metni en fazla ${GUIDE_BODY_MAX} karakter olabilir.` };
  }
  try {
    await apiPost('/v1/admin/product-guides', { title, body }, await getActor());
    await revalidateGuideScreens();
    return { ok: true, message: `“${title}” rehberi eklendi.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

export async function updateGuideAction(
  _prev: GuideFormState,
  formData: FormData,
): Promise<GuideFormState> {
  const id = String(formData.get('id') || '');
  const title = String(formData.get('title') || '').trim();
  const body = String(formData.get('body') || '').trim();
  if (!isUuid(id)) return { ok: false, error: 'Rehber seçilmedi (geçersiz kayıt kimliği).' };
  if (!title) return { ok: false, error: 'Rehber başlığı zorunlu' };
  if (!body) return { ok: false, error: 'Rehber metni zorunlu' };
  if (body.length > GUIDE_BODY_MAX) {
    return { ok: false, error: `Rehber metni en fazla ${GUIDE_BODY_MAX} karakter olabilir.` };
  }
  try {
    await apiSend('PATCH', `/v1/admin/product-guides/${id}`, { title, body }, await getActor());
    await revalidateGuideScreens();
    return { ok: true, message: 'Rehber güncellendi — bağlı tüm ürünlerde geçerli.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/**
 * Rehberi sil. ÜRÜNLER SİLİNMEZ — rehbersiz kalırlar (API `ON DELETE SET NULL`).
 * Kaç ürünün etkilendiği yanıttan okunup operatöre SÖYLENİR (sessiz yan etki yok).
 */
export async function deleteGuideAction(id: string): Promise<GuideFormState> {
  if (!isUuid(id)) return { ok: false, error: 'Geçersiz rehber kimliği — liste yenilenmeli.' };
  try {
    const res = await apiSend<{ affectedProducts?: number }>(
      'DELETE',
      `/v1/admin/product-guides/${id}`,
      undefined,
      await getActor(),
    );
    await revalidateGuideScreens();
    const n = res?.affectedProducts ?? 0;
    return {
      ok: true,
      message:
        n > 0
          ? `Rehber silindi — ${n} ürün artık kurulum rehberi göstermeyecek.`
          : 'Rehber silindi.',
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}
