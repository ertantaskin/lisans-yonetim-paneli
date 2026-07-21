'use server';
import { apiPost } from '../../../lib/api';
import { getActor } from '../../../lib/session';

/** Sihirbaz Adım 1 girdisi — site oluşturma alanları (plain object, FormData değil). */
export interface IssueCodeInput {
  domain: string;
  type: string;
  senderEmail?: string;
  webhookUrl?: string;
  sandbox?: boolean;
  salesDailyQuota?: number;
}

export interface IssueCodeResult {
  ok: boolean;
  error?: string;
  siteId?: string;
  /** Tek-seferlik bağlan kodu — WP eklentisine girilir. */
  code?: string;
  /** Kodun son kullanma zamanı (ISO). */
  expiresAt?: string;
}

/**
 * Onboarding sihirbazı Adım 1 (§14): site oluştur + tek-seferlik bağlan kodu üret.
 * Önce POST /v1/admin/sites ile site kaydı açılır, ardından
 * POST /v1/admin/onboarding/sites/:id/connect-code ile kısa ömürlü kod alınır.
 * Server action ASLA fırlatmaz; hata ok=false + Türkçe mesaj olarak istemciye döner.
 */
export async function createSiteAndIssueCode(input: IssueCodeInput): Promise<IssueCodeResult> {
  const domain = input.domain?.trim();
  if (!domain) return { ok: false, error: 'Domain zorunlu' };
  try {
    const actor = await getActor();
    const site = await apiPost<{ id: string }>(
      '/v1/admin/sites',
      {
        domain,
        type: input.type,
        ...(input.senderEmail ? { senderEmail: input.senderEmail } : {}),
        ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
        ...(input.sandbox ? { sandbox: true } : {}),
        ...(input.salesDailyQuota != null ? { salesDailyQuota: input.salesDailyQuota } : {}),
      },
      actor,
    );
    const { code, expiresAt } = await apiPost<{ code: string; expiresAt: string }>(
      `/v1/admin/onboarding/sites/${site.id}/connect-code`,
      undefined,
      actor,
    );
    return { ok: true, siteId: site.id, code, expiresAt };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Site oluşturulamadı' };
  }
}

export interface WizardCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  /** Teşhis sonuçları — site kaydı + durum + HMAC secret + (varsa) webhook. */
  checks?: WizardCheck[];
}

/**
 * Sihirbaz Adım 3 (§14): bağlantı sağlık testi. POST /v1/admin/sites/:id/test-connection
 * — site kaydı + durum + HMAC secret geçerliliği + (varsa) webhook erişilebilirliği teşhisi.
 * Salt-okunur; SIR göstermez. Hata durumunda ok=false + Türkçe mesaj (fırlatmaz).
 */
export async function testConnectionAction(siteId: string): Promise<TestConnectionResult> {
  if (!siteId) return { ok: false, error: 'Site id zorunlu' };
  try {
    const actor = await getActor();
    const result = await apiPost<{ ok: boolean; checks: WizardCheck[] }>(
      `/v1/admin/sites/${encodeURIComponent(siteId)}/test-connection`,
      undefined,
      actor,
    );
    return { ok: result.ok, checks: result.checks };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Bağlantı testi başarısız' };
  }
}
