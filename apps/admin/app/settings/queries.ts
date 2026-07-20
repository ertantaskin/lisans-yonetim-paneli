import 'server-only';
import { apiGet } from '../../lib/api';
import { authEnabled } from '../../lib/auth';

/**
 * Ayarlar / sistem durumu — SALT-OKUNUR yansıma (§14/§16).
 *
 * KRİTİK GÜVENLİK: Buradan hiçbir SIR (token/secret/bot token/chat id) DÜZ METİN
 * DÖNMEZ. env değişkenleri yalnız "yapılandırıldı / kapalı" (boolean) olarak
 * yansıtılır; değerleri asla okunmaz/gönderilmez. Tüm okuma sunucu-tarafında kalır
 * ('server-only'); tipler view'e yalnız `import type` ile geçer.
 */

export interface EnvFlag {
  /** Görünen ad (değişken adı bilgi amaçlı; değer ASLA yok). */
  label: string;
  /** env tanımlı mı (sır değeri gizli). */
  configured: boolean;
  /** Kısa açıklama. */
  hint: string;
}

export interface SitesSummary {
  total: number;
  sandbox: number;
  live: number;
}

export interface SystemStatus {
  /** Çoklu-admin oturum kapısı açık mı (SESSION_SECRET set). */
  authEnabled: boolean;
  /** Telegram bildirimi (§12) yapılandırılmış mı — bot token + chat id birlikte. */
  telegramConfigured: boolean;
  /** Sunucu-taraflı env yansımaları (yalnız yapılandırıldı/kapalı). */
  env: EnvFlag[];
  /** Site özeti (sandbox/canlı) — API erişilemezse null. */
  sites: SitesSummary | null;
  /** Site özeti çekilemediyse hata mesajı. */
  sitesError: string | null;
  runtime: {
    /** Uygulama sürümü (env yoksa 0.0.0). */
    version: string;
    /** Node çalışma zamanı sürümü. */
    node: string;
    /** NODE_ENV (development/production). */
    env: string;
  };
}

/** Bir env değişkeninin (SIR) tanımlı olup olmadığı — değeri asla dönmez. */
function isSet(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0;
}

/** Site listesindeki asgari alanlar (sandbox sayımı için). Payload/sır YOK. */
interface SiteLite {
  sandbox?: boolean;
  status?: string;
}

/**
 * Sistem durumunu toplar. env yansımaları senkron + her zaman çalışır; site özeti
 * ayrı try/catch (API kapalıyken bile durum sayfası yüklenir).
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  let sites: SitesSummary | null = null;
  let sitesError: string | null = null;
  try {
    const rows = await apiGet<SiteLite[]>('/v1/admin/sites');
    const sandbox = rows.filter((s) => s.sandbox === true).length;
    sites = { total: rows.length, sandbox, live: rows.length - sandbox };
  } catch (e) {
    sitesError = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  const env: EnvFlag[] = [
    { label: 'API_URL', configured: isSet('API_URL'), hint: 'Panel API adresi' },
    { label: 'ADMIN_TOKEN', configured: isSet('ADMIN_TOKEN'), hint: 'Sunucu-içi API kimliği (sır)' },
    { label: 'SESSION_SECRET', configured: isSet('SESSION_SECRET'), hint: 'Oturum imzalama anahtarı (sır)' },
    { label: 'TELEGRAM_BOT_TOKEN', configured: isSet('TELEGRAM_BOT_TOKEN'), hint: 'Telegram bot anahtarı (sır)' },
    { label: 'TELEGRAM_CHAT_ID', configured: isSet('TELEGRAM_CHAT_ID'), hint: 'Telegram hedef sohbeti' },
  ];

  return {
    authEnabled: authEnabled(),
    telegramConfigured: isSet('TELEGRAM_BOT_TOKEN') && isSet('TELEGRAM_CHAT_ID'),
    env,
    sites,
    sitesError,
    runtime: {
      version: process.env.APP_VERSION ?? '0.0.0',
      node: process.version,
      env: process.env.NODE_ENV ?? 'development',
    },
  };
}
