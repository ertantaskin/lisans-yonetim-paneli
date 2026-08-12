import 'server-only';
// Default import: named export ('version') kullanımı Next'te "only default export is available
// soon" uyarısı üretiyor — paketin tamamını alıp alanı okuyoruz (aynı sonuç, uyarısız).
import pkg from '../../package.json';
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

/**
 * API konteynerinin yapılandırma bayrakları (`GET /v1/admin/system/status`) — yalnız boolean.
 * Bu değerler API env'inde yaşar; admin konteyneri onları GÖREMEZ (eski kod admin env'ine
 * bakıp Telegram'ı her zaman "kapalı" gösteriyordu — yanlış bilgi).
 */
export interface ApiFlags {
  mailRelay: boolean;
  mailAuth: boolean;
  telegram: boolean;
  sentry: boolean;
  ai: boolean;
}

export interface SystemStatus {
  /** Çoklu-admin oturum kapısı açık mı (SESSION_SECRET set). */
  authEnabled: boolean;
  /** Telegram bildirimi (§12) yapılandırılmış mı — API'den gelir; API erişilemezse null. */
  telegramConfigured: boolean | null;
  /** API tarafı yapılandırma bayrakları — erişilemezse null (ekran "bilinmiyor" gösterir). */
  apiFlags: ApiFlags | null;
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

  // API tarafı bayrakları (mail relay / Telegram / Sentry / AI) — bunlar API konteynerinin
  // env'indedir; admin env'ine bakmak YANLIŞ sonuç veriyordu. Erişilemezse null → "bilinmiyor".
  let apiFlags: ApiFlags | null = null;
  try {
    apiFlags = await apiGet<ApiFlags>('/v1/admin/system/status');
  } catch {
    /* API kapalı/eski sürüm → bilinmiyor (ekran dürüstçe böyle gösterir) */
  }

  const env: EnvFlag[] = [
    { label: 'API_URL', configured: isSet('API_URL'), hint: 'Panel API adresi' },
    { label: 'ADMIN_TOKEN', configured: isSet('ADMIN_TOKEN'), hint: 'Sunucu-içi API kimliği (sır)' },
    { label: 'SESSION_SECRET', configured: isSet('SESSION_SECRET'), hint: 'Oturum imzalama anahtarı (sır)' },
    // Aşağıdakiler API konteynerinden okunur (admin env'inde YOKTUR) — kaynak farkı hint'te belirtilir.
    {
      label: 'SMTP (gerçek relay)',
      configured: apiFlags?.mailRelay ?? false,
      hint: apiFlags
        ? apiFlags.mailRelay
          ? `API: gerçek relay${apiFlags.mailAuth ? ' (kimlikli)' : ''}`
          : 'API: DEV yakalayıcı — mailler müşteriye ULAŞMIYOR'
        : 'API erişilemedi — bilinmiyor',
    },
    {
      label: 'TELEGRAM (alarm kanalı)',
      configured: apiFlags?.telegram ?? false,
      hint: apiFlags ? 'API konteyneri env' : 'API erişilemedi — bilinmiyor',
    },
    {
      label: 'SENTRY',
      configured: apiFlags?.sentry ?? false,
      hint: apiFlags ? 'API konteyneri env (opsiyonel)' : 'API erişilemedi — bilinmiyor',
    },
  ];

  return {
    authEnabled: authEnabled(),
    telegramConfigured: apiFlags ? apiFlags.telegram : null,
    apiFlags,
    env,
    sites,
    sitesError,
    runtime: {
      // package.json TEK doğruluk kaynağı: env geçilmezse sürüm '0.0.0' görünüyordu (import
      // edilmiş APP_VERSION kullanılmıyordu — ölü import). Artık env > package.json sırası.
      version: process.env.APP_VERSION?.trim() || pkg.version,
      node: process.version,
      env: process.env.NODE_ENV ?? 'development',
    },
  };
}
