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
    // Günlük satış kotası (ops.) — boş bırakılırsa limitsiz (null). Negatif/0 reddedilir.
    const quotaRaw = String(formData.get('salesDailyQuota') || '').trim();
    let salesDailyQuota: number | null = null;
    if (quotaRaw) {
      const n = Number(quotaRaw);
      if (!Number.isInteger(n) || n < 1) {
        return { ok: false, error: 'Günlük satış kotası pozitif tam sayı olmalı' };
      }
      salesDailyQuota = n;
    }
    // Sandbox (test modu) — checkbox işaretliyse mailler gerçek müşteriye GİTMEZ.
    const sandbox = formData.get('sandbox') != null;
    const site = await apiPost<CreateSiteState['site']>('/v1/admin/sites', {
      domain,
      ...(senderEmail ? { senderEmail } : {}),
      ...(salesDailyQuota != null ? { salesDailyQuota } : {}),
      ...(sandbox ? { sandbox: true } : {}),
    });
    revalidatePath('/sites');
    return { ok: true, site };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

export interface RotateSecretState {
  ok: boolean;
  error?: string;
  siteId?: string;
  /** Yeni HMAC secret — YALNIZ bir kez döner, kullanıcıya gösterilir. */
  hmacSecret?: string;
}

/**
 * HMAC secret rotasyonu (§4). Yeni secret YALNIZ bir kez döner; eski secret 24 saat
 * daha geçerli kalır → WP eklentisi kesintisiz yeni secret'a geçer.
 */
export async function rotateSecretAction(siteId: string): Promise<RotateSecretState> {
  if (!siteId) return { ok: false, error: 'Site id zorunlu' };
  try {
    const { hmacSecret } = await apiPost<{ hmacSecret: string }>(
      `/v1/admin/sites/${siteId}/rotate-secret`,
    );
    revalidatePath('/sites');
    return { ok: true, siteId, hmacSecret };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}
