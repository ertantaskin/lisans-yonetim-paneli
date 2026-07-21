'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, apiSend } from '../../lib/api';
import { getActor, isOwner } from '../../lib/session';

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
    const actor = await getActor();
    const site = await apiPost<CreateSiteState['site']>(
      '/v1/admin/sites',
      {
        domain,
        ...(senderEmail ? { senderEmail } : {}),
        ...(salesDailyQuota != null ? { salesDailyQuota } : {}),
        ...(sandbox ? { sandbox: true } : {}),
      },
      actor,
    );
    revalidatePath('/sites');
    return { ok: true, site };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

export interface UpdateSiteState {
  ok: boolean;
  error?: string;
  /** Başarı feedback'i için yalnız başarıda true. */
  saved?: boolean;
}

/**
 * Site operasyon ayarlarını günceller (§5/§14): günlük satış kotası + sandbox + gönderen
 * e-posta. PATCH /v1/admin/sites/:id — audit'e düşer. Yalnız verilen alanlar değişir.
 */
export async function updateSiteAction(
  _prev: UpdateSiteState,
  formData: FormData,
): Promise<UpdateSiteState> {
  const siteId = String(formData.get('siteId') || '').trim();
  if (!siteId) return { ok: false, error: 'Site id zorunlu' };
  try {
    // Günlük satış kotası — boş = limitsiz (null). Negatif/0 reddedilir.
    const quotaRaw = String(formData.get('salesDailyQuota') || '').trim();
    let salesDailyQuota: number | null = null;
    if (quotaRaw) {
      const n = Number(quotaRaw);
      if (!Number.isInteger(n) || n < 1) {
        return { ok: false, error: 'Günlük satış kotası pozitif tam sayı olmalı' };
      }
      salesDailyQuota = n;
    }
    // Gönderen e-posta — boş = varsayılan gönderene dön (null).
    const senderRaw = String(formData.get('senderEmail') || '').trim();
    const senderEmail: string | null = senderRaw ? senderRaw : null;
    // Geri kanal webhook hedefi (§2) — boş = temizle (webhook devre dışı, null).
    const webhookRaw = String(formData.get('webhookUrl') || '').trim();
    const webhookUrl: string | null = webhookRaw ? webhookRaw : null;
    // Sandbox (test modu) — checkbox işaretliyse true.
    const sandbox = formData.get('sandbox') != null;

    const actor = await getActor();
    await apiSend(
      'PATCH',
      `/v1/admin/sites/${encodeURIComponent(siteId)}`,
      {
        salesDailyQuota,
        sandbox,
        senderEmail,
        webhookUrl,
      },
      actor,
    );
    revalidatePath(`/sites/${siteId}`);
    revalidatePath('/sites');
    return { ok: true, saved: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

export interface SetSiteStatusState {
  ok: boolean;
  error?: string;
  siteId?: string;
  status?: 'active' | 'suspended';
}

/**
 * Site yaşam döngüsü (§8): askıya al / aktifleştir. 'suspended' → HMAC auth reddedilir
 * (yeni sipariş push'u durur). PATCH /v1/admin/sites/:id — audit'e düşer.
 */
export async function setSiteStatusAction(
  siteId: string,
  status: 'active' | 'suspended',
): Promise<SetSiteStatusState> {
  // RBAC (§8): askıya alma HMAC auth'u kesip sipariş push'unu durdurur → yalnız owner.
  if (!(await isOwner())) return { ok: false, error: 'Bu işlem için owner yetkisi gerekir.' };
  if (!siteId) return { ok: false, error: 'Site id zorunlu' };
  try {
    const actor = await getActor();
    await apiSend('PATCH', `/v1/admin/sites/${encodeURIComponent(siteId)}`, { status }, actor);
    revalidatePath(`/sites/${siteId}`);
    revalidatePath('/sites');
    return { ok: true, siteId, status };
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

export interface ConnectionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TestConnectionState {
  ok: boolean;
  error?: string;
  /** Teşhis çalıştı mı (sonuç var mı) — buton sonrası inline gösterim için. */
  tested?: boolean;
  /** Genel sağlık: tüm check'ler geçtiyse true. */
  healthy?: boolean;
  checks?: ConnectionCheck[];
}

/**
 * Site bağlantı sağlık testi (onboarding): API test-connection ucunu çağırır — site
 * kaydı + durum + HMAC secret geçerliliği + (varsa) webhook erişilebilirliği teşhisini
 * döndürür. SIR göstermez. Salt-okunur teşhis (mutation değil); actor tutarlılık için geçilir.
 */
export async function testConnectionAction(siteId: string): Promise<TestConnectionState> {
  if (!siteId) return { ok: false, error: 'Site id zorunlu' };
  try {
    const actor = await getActor();
    const result = await apiPost<{ ok: boolean; checks: ConnectionCheck[] }>(
      `/v1/admin/sites/${encodeURIComponent(siteId)}/test-connection`,
      undefined,
      actor,
    );
    return { ok: true, tested: true, healthy: result.ok, checks: result.checks };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}

/**
 * HMAC secret rotasyonu (§4). Yeni secret YALNIZ bir kez döner; eski secret 24 saat
 * daha geçerli kalır → WP eklentisi kesintisiz yeni secret'a geçer.
 */
export async function rotateSecretAction(siteId: string): Promise<RotateSecretState> {
  // RBAC (§8): HMAC sır rotasyonu güven kökünü değiştirir → yalnız owner.
  if (!(await isOwner())) return { ok: false, error: 'Bu işlem için owner yetkisi gerekir.' };
  if (!siteId) return { ok: false, error: 'Site id zorunlu' };
  try {
    const actor = await getActor();
    const { hmacSecret } = await apiPost<{ hmacSecret: string }>(
      `/v1/admin/sites/${siteId}/rotate-secret`,
      undefined,
      actor,
    );
    revalidatePath('/sites');
    return { ok: true, siteId, hmacSecret };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Hata' };
  }
}
