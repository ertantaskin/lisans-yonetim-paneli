'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, apiSend, isUuid } from '@/lib/api';
import { getActor } from '@/lib/session';

/**
 * SEC-1 — YOL ENJEKSİYONU: tedarikçi kimliği doğrudan API YOLUNA gömülür ve sunucu
 * aksiyonları TS tiplerini ÇALIŞMA ANINDA zorlamaz (uç dışarıdan serileştirilmiş argümanla
 * çağrılabilir) → boş OLMAYAN ama `..` taşıyan bir değer owner-only başka bir uca düşerdi.
 * Kimlik UUID kalıbına bağlanır; `lib/api` merkezî kapısı ikinci savunma hattıdır.
 */
const INVALID_SUPPLIER_ID = 'Geçersiz tedarikçi kimliği — liste yenilenip tekrar denenmeli.';

/**
 * DİKKAT: Bu dosya 'use server' modülüdür — Next 15 SWC buraya
 * `ensureServerEntryExports` enjekte eder ve async fonksiyon OLMAYAN bir export
 * görürse "can only export async functions, found object" fırlatıp TÜM action
 * chunk'ını patlatır (bkz. commit 9b81c9b, stock-adjust-form). Bu yüzden burada
 * YALNIZ `export async function` ve `export type/interface` bulunabilir.
 * Başlangıç durumu objeleri tüketici istemci bileşenlerinde yerel sabit tutulur.
 */
export interface SupplierFormState {
  ok: boolean;
  error?: string;
}

/** Yeni tedarikçi oluştur (§12). name zorunlu; contact/notes opsiyonel. */
export async function createSupplierAction(
  _prev: SupplierFormState,
  formData: FormData,
): Promise<SupplierFormState> {
  const name = String(formData.get('name') || '').trim();
  if (!name) return { ok: false, error: 'Ad zorunlu' };
  const contact = String(formData.get('contact') || '').trim();
  const notes = String(formData.get('notes') || '').trim();
  try {
    await apiPost(
      '/v1/admin/suppliers',
      {
        name,
        ...(contact ? { contact } : {}),
        ...(notes ? { notes } : {}),
      },
      await getActor(),
    );
    revalidatePath('/suppliers');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/** Tedarikçi güncelle (ad/iletişim/not). Boş bırakılan iletişim/not alanları null'a çekilir. */
export async function updateSupplierAction(
  _prev: SupplierFormState,
  formData: FormData,
): Promise<SupplierFormState> {
  const id = String(formData.get('id') || '').trim();
  if (!isUuid(id)) return { ok: false, error: INVALID_SUPPLIER_ID };
  const name = String(formData.get('name') || '').trim();
  if (!name) return { ok: false, error: 'Ad zorunlu' };
  const contact = String(formData.get('contact') || '').trim();
  const notes = String(formData.get('notes') || '').trim();
  try {
    await apiSend(
      'PATCH',
      `/v1/admin/suppliers/${id}`,
      {
        name,
        contact: contact || null,
        notes: notes || null,
      },
      await getActor(),
    );
    revalidatePath('/suppliers');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/** Aktif/pasif durumunu değiştir (pasifleştirme = active:false). */
export async function setSupplierActiveAction(id: string, active: boolean): Promise<SupplierFormState> {
  if (!isUuid(id)) return { ok: false, error: INVALID_SUPPLIER_ID };
  try {
    await apiSend('PATCH', `/v1/admin/suppliers/${id}`, { active }, await getActor());
    revalidatePath('/suppliers');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}
