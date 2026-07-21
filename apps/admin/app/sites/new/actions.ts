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
  /**
   * Site kaydı açıldı ama bağlan kodu üretilemedi (ok=false + siteId dolu). UI bu durumda
   * formu yeniden GÖNDERTMEMELİ (aynı domain artık reddedilir); onun yerine siteId ile
   * `issueCodeForSite` çağırıp kodu tekrar üretmeli — yetim site kalmasın.
   */
  siteCreated?: boolean;
  /** Tek-seferlik bağlan kodu — WP eklentisine girilir. */
  code?: string;
  /** Kodun son kullanma zamanı (ISO). */
  expiresAt?: string;
}

/**
 * Nest hata gövdesinden (apiPost `POST /path → 409 {"message":...}` biçiminde fırlatır)
 * insan-okur mesajı ayıklar. JSON `message` alanı varsa onu, yoksa ham metni döndürür.
 */
function apiErrorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback;
  const jsonStart = e.message.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const body = JSON.parse(e.message.slice(jsonStart)) as { message?: string | string[] };
      if (Array.isArray(body.message) && body.message.length) return body.message.join('; ');
      if (typeof body.message === 'string' && body.message) return body.message;
    } catch {
      // JSON değilse ham mesaja düş.
    }
  }
  return e.message || fallback;
}

/**
 * Bir site için tek-seferlik bağlan kodu üretir (POST /v1/admin/onboarding/sites/:id/connect-code).
 * Geçici bir ağ/DB titremesine karşı bir kez tekrar dener. Uç idempotent güvenlidir: her çağrı
 * creds'i yeniden üretir (rekey) ve önceki tüketilmemiş kodları geçersiz kılar → tek aktif kod.
 */
async function issueCode(
  siteId: string,
  actor: string,
): Promise<{ code: string; expiresAt: string }> {
  try {
    return await apiPost<{ code: string; expiresAt: string }>(
      `/v1/admin/onboarding/sites/${encodeURIComponent(siteId)}/connect-code`,
      undefined,
      actor,
    );
  } catch {
    // Tek tekrar: create başarılıysa API ayakta demektir; kod üretimi hatası çoğunlukla geçici.
    return await apiPost<{ code: string; expiresAt: string }>(
      `/v1/admin/onboarding/sites/${encodeURIComponent(siteId)}/connect-code`,
      undefined,
      actor,
    );
  }
}

/**
 * Onboarding sihirbazı Adım 1 (§14): site oluştur + tek-seferlik bağlan kodu üret.
 * Önce POST /v1/admin/sites ile site kaydı açılır, ardından connect-code alınır.
 *
 * Dayanıklılık (§14 sertleştirme): iki çağrı ayrık olduğundan, site oluşup KOD üretimi
 * patlarsa YETİM site kalır (üstelik aynı domain artık reddedildiği için form yeniden
 * gönderilemez). Bunu önlemek için: (1) kod üretimi bir kez tekrar denenir; (2) yine de
 * başarısızsa site YOK EDİLMEZ — siteId + siteCreated=true ile NET hata döner, böylece UI
 * (veya operatör) `issueCodeForSite(siteId)` ile kodu tekrar üretebilir. Server action ASLA
 * fırlatmaz; hata ok=false + Türkçe mesaj olarak döner.
 */
export async function createSiteAndIssueCode(input: IssueCodeInput): Promise<IssueCodeResult> {
  const domain = input.domain?.trim();
  if (!domain) return { ok: false, error: 'Domain zorunlu' };

  const actor = await getActor();

  // 1) Site kaydı. Başarısızsa (ör. domain zaten kayıtlı → 409) hiç site oluşmaz; düz hata.
  let siteId: string;
  try {
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
    siteId = site.id;
  } catch (e) {
    return { ok: false, error: apiErrorMessage(e, 'Site oluşturulamadı') };
  }

  // 2) Bağlan kodu. Site ARTIK var; buradaki hata yetim siteye yol açar → siteId'yi geri ver.
  try {
    const { code, expiresAt } = await issueCode(siteId, actor);
    return { ok: true, siteId, code, expiresAt };
  } catch (e) {
    return {
      ok: false,
      siteId,
      siteCreated: true,
      error:
        `Site (${domain}) oluşturuldu ancak bağlan kodu üretilemedi: ` +
        `${apiErrorMessage(e, 'bilinmeyen hata')}. Formu tekrar göndermeyin (domain artık ` +
        `kayıtlı); "Kodu Tekrar Üret" ile yeniden deneyin.`,
    };
  }
}

/**
 * Var olan bir site için bağlan kodunu (yeniden) üretir — createSiteAndIssueCode'un kod
 * adımı patladığında yetim siteyi kurtarma yolu (§14). Yeni site OLUŞTURMAZ; yalnız siteId
 * ile connect-code üretir. Server action ASLA fırlatmaz.
 */
export async function issueCodeForSite(siteId: string): Promise<IssueCodeResult> {
  if (!siteId) return { ok: false, error: 'Site id zorunlu' };
  try {
    const actor = await getActor();
    const { code, expiresAt } = await issueCode(siteId, actor);
    return { ok: true, siteId, code, expiresAt };
  } catch (e) {
    return { ok: false, siteId, error: apiErrorMessage(e, 'Bağlan kodu üretilemedi') };
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
