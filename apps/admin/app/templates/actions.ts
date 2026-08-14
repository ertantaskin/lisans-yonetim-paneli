'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiPost, apiSend, isUuid } from '../../lib/api';
import { getActor } from '../../lib/session';

/**
 * SEC-1 — YOL ENJEKSİYONU: şablon kimliği API YOLUNA (ve `revalidatePath`/`redirect` yoluna)
 * gömülür. Sunucu aksiyonları TS tiplerini ÇALIŞMA ANINDA zorlamaz — action uç noktası
 * dışarıdan, serileştirilmiş argümanlarla çağrılabilir → `'../sites/<id>/rotate-secret?x='`
 * gibi bir değer WHATWG URL normalizasyonuyla owner-only bir uca düşerdi. Kimlik UUID
 * kalıbına bağlanır; `lib/api` merkezî kapısı ikinci savunma hattıdır.
 */
const INVALID_TEMPLATE_ID = 'Geçersiz şablon kimliği — liste yenilenip tekrar denenmeli.';

export interface TemplateFormState {
  ok: boolean;
  error?: string;
}

/** Boş string → null (opsiyonel FK). uuid doğrulaması API tarafında. */
function nullable(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

/**
 * Şablon oluştur → başarıda /templates/[id] editörüne yönlendirir. redirect() bir
 * exception fırlattığı için try DIŞINDA çağrılır (aksi halde catch yakalar).
 */
export async function createTemplateAction(
  _prev: TemplateFormState,
  formData: FormData,
): Promise<TemplateFormState> {
  const subject = String(formData.get('subject') || '').trim();
  const body = String(formData.get('body') || '').trim();
  if (!subject || !body) return { ok: false, error: 'Konu ve gövde zorunlu' };

  let newId: string;
  try {
    const res = await apiPost<{ id: string }>(
      '/v1/admin/templates',
      {
        subject,
        body,
        productId: nullable(formData.get('productId')),
        siteId: nullable(formData.get('siteId')),
      },
      await getActor(),
    );
    newId = res.id;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
  revalidatePath('/templates');
  redirect(`/templates/${newId}`);
}

/** Mevcut şablonu güncelle. */
export async function updateTemplateAction(
  id: string,
  _prev: TemplateFormState,
  formData: FormData,
): Promise<TemplateFormState> {
  const subject = String(formData.get('subject') || '').trim();
  const body = String(formData.get('body') || '').trim();
  if (!isUuid(id)) return { ok: false, error: INVALID_TEMPLATE_ID };
  if (!subject || !body) return { ok: false, error: 'Konu ve gövde zorunlu' };
  try {
    await apiSend(
      'PATCH',
      `/v1/admin/templates/${id}`,
      {
        subject,
        body,
        productId: nullable(formData.get('productId')),
        siteId: nullable(formData.get('siteId')),
      },
      await getActor(),
    );
    revalidatePath('/templates');
    revalidatePath(`/templates/${id}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/** Şablon sil → listeye döner. */
export async function deleteTemplateAction(id: string): Promise<TemplateFormState> {
  if (!isUuid(id)) return { ok: false, error: INVALID_TEMPLATE_ID };
  try {
    await apiSend('DELETE', `/v1/admin/templates/${id}`, undefined, await getActor());
    revalidatePath('/templates');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

export interface PreviewState {
  ok: boolean;
  error?: string;
  subject?: string;
  body?: string;
  /** Şablonda kullanılan ama DESTEKLENMEYEN değişkenler (render'da boş çıkar) — uyarı. */
  unknownVars?: string[];
}

/** Sunucu-taraflı önizleme (örnek değişkenlerle render, gönderim yok). */
export async function previewTemplateAction(id: string): Promise<PreviewState> {
  if (!isUuid(id)) return { ok: false, error: INVALID_TEMPLATE_ID };
  try {
    const res = await apiPost<{ subject: string; body: string; unknownVars: string[] }>(
      `/v1/admin/templates/${id}/preview`,
      {},
    );
    return { ok: true, subject: res.subject, body: res.body, unknownVars: res.unknownVars };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

export interface TestMailState {
  ok: boolean;
  sent?: boolean;
  error?: string;
}

/** Test maili gönder (örnek verilerle). */
export async function testTemplateAction(id: string, toEmail: string): Promise<TestMailState> {
  const email = String(toEmail ?? '').trim();
  if (!isUuid(id)) return { ok: false, error: INVALID_TEMPLATE_ID };
  if (!email) return { ok: false, error: 'E-posta zorunlu' };
  try {
    const res = await apiPost<{ ok: boolean; error?: string }>(
      `/v1/admin/templates/${id}/test`,
      { toEmail: email },
      await getActor(),
    );
    if (!res.ok) return { ok: false, error: res.error ?? 'Gönderim başarısız' };
    return { ok: true, sent: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}
