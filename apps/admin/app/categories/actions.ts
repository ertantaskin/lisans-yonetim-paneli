'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, apiSend, isUuid } from '@/lib/api';
import { getActor } from '@/lib/session';

/**
 * SEC-1 — YOL ENJEKSİYONU: kategori kimliği doğrudan API YOLUNA gömülür. Sunucu aksiyonları
 * TS tiplerini ÇALIŞMA ANINDA zorlamaz (uç dışarıdan, serileştirilmiş argümanlarla
 * çağrılabilir) → `'../sites/<id>/rotate-secret?x='` gibi bir değer BOŞ DEĞİL ama WHATWG URL
 * normalizasyonuyla owner-only başka bir uca düşerdi. Kimlik UUID kalıbına bağlanır;
 * `lib/api` merkezî kapısı ikinci savunma hattıdır.
 */

/**
 * DİKKAT: 'use server' modülü — YALNIZ `export async function` ve `export type/interface`
 * bulunabilir. Obje export'u Next 15'te çalışma anında tüm action chunk'ını patlatır
 * (bkz. commit 9b81c9b / ee59e14; `scripts/check-use-server.js` bunu CI'da kontrol eder).
 */
export interface CategoryFormState {
  ok: boolean;
  error?: string;
  /** Başarı mesajı — silmede kaç ürünün kategorisiz kaldığını dürüstçe söyler. */
  message?: string;
}

/** Kategori ekranı ve ürün listesi aynı veriyi gösterir → ikisi birlikte tazelenir. */
async function revalidateCategoryScreens() {
  revalidatePath('/categories');
  revalidatePath('/stock');
}

export async function createCategoryAction(
  _prev: CategoryFormState,
  formData: FormData,
): Promise<CategoryFormState> {
  const name = String(formData.get('name') || '').trim();
  if (!name) return { ok: false, error: 'Kategori adı zorunlu' };
  const description = String(formData.get('description') || '').trim();
  const sortRaw = String(formData.get('sortOrder') || '').trim();
  try {
    await apiPost(
      '/v1/admin/product-categories',
      {
        name,
        ...(description ? { description } : {}),
        ...(sortRaw ? { sortOrder: Number(sortRaw) } : {}),
      },
      await getActor(),
    );
    await revalidateCategoryScreens();
    return { ok: true, message: `“${name}” kategorisi eklendi.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

export async function updateCategoryAction(
  _prev: CategoryFormState,
  formData: FormData,
): Promise<CategoryFormState> {
  const id = String(formData.get('id') || '');
  const name = String(formData.get('name') || '').trim();
  if (!isUuid(id)) return { ok: false, error: 'Kategori seçilmedi (geçersiz kayıt kimliği).' };
  if (!name) return { ok: false, error: 'Kategori adı zorunlu' };
  const description = String(formData.get('description') || '').trim();
  const sortRaw = String(formData.get('sortOrder') || '').trim();
  try {
    await apiSend('PATCH', `/v1/admin/product-categories/${id}`, {
      name,
      // Boş bırakılan açıklama TEMİZLENİR (null) — "değişmedi" ile karışmasın.
      description: description || null,
      // Boş bırakılan sıra da TEMİZLENİR (0 = "otomatik sıra"). Eskiden alan atlanıyordu:
      // operatör kutuyu boşaltıp kaydediyor, "Kategori güncellendi" mesajını görüyor ama
      // eski sabitleme sırası sessizce duruyordu — açıklama alanıyla tutarsız, yanıltıcıydı.
      // NaN gönderilmez (kutu boş değil ama sayı değilse 0'a düşer → API 400 yerine sıfırlama).
      sortOrder: sortRaw && Number.isFinite(Number(sortRaw)) ? Number(sortRaw) : 0,
    }, await getActor());
    await revalidateCategoryScreens();
    return { ok: true, message: 'Kategori güncellendi.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/**
 * Kategoriyi sil. ÜRÜNLER SİLİNMEZ — kategorisiz kalırlar (API `ON DELETE SET NULL`).
 * Kaç ürünün etkilendiği yanıttan okunup operatöre söylenir (sessiz yan etki yok).
 */
export async function deleteCategoryAction(id: string): Promise<CategoryFormState> {
  if (!isUuid(id)) return { ok: false, error: 'Geçersiz kategori kimliği — liste yenilenmeli.' };
  try {
    const res = await apiSend<{ uncategorizedProducts?: number }>(
      'DELETE',
      `/v1/admin/product-categories/${id}`,
      undefined,
      await getActor(),
    );
    await revalidateCategoryScreens();
    const n = res?.uncategorizedProducts ?? 0;
    return {
      ok: true,
      message:
        n > 0
          ? `Kategori silindi — ${n} ürün “Kategorisiz” oldu.`
          : 'Kategori silindi.',
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}
