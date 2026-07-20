'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';

export interface CreateSiteState {
  ok: boolean;
  error?: string;
  site?: { id: string; domain: string; apiKey: string; hmacSecret: string };
}

/** Site oluştur — apiKey + hmacSecret YALNIZ bir kez döner, kullanıcıya gösterilir. */
export async function createSiteAction(
  _prev: CreateSiteState,
  formData: FormData,
): Promise<CreateSiteState> {
  const domain = String(formData.get('domain') || '').trim();
  if (!domain) return { ok: false, error: 'Domain zorunlu' };
  try {
    const senderEmail = String(formData.get('senderEmail') || '').trim();
    const site = await apiPost<CreateSiteState['site']>('/v1/admin/sites', {
      domain,
      ...(senderEmail ? { senderEmail } : {}),
    });
    revalidatePath('/sites');
    return { ok: true, site };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}
