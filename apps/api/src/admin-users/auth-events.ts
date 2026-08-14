import type { Database } from '../db/db.module';
import { securityEvents } from '../db/schema/securityEvents';

/**
 * Admin auth/hesap YAŞAM DÖNGÜSÜ denetim izi (denetim A4) — PAYLAŞILAN yazıcı.
 *
 * NEDEN ayrı dosya: aynı yazıcıyı hem `AdminUsersService` (login/create/disable/reset) hem
 * `AdminTotpService` (TOTP aç/kapat/sıfırla) kullanıyor. Metodu birinden diğerine çağırmak
 * iki servis arasında DAİRESEL import doğururdu; ortak bir modül bunu baştan keser.
 *
 * Best-effort: yazım hatası auth/CRUD akışını ASLA bozmaz (ize düşmeyen bir olay yüzünden
 * giriş reddedilmemeli). `security_events.type/severity` serbest metindir → migration gerekmez.
 * SIR (parola, TOTP sırrı, kod) meta'ya ASLA yazılmaz.
 */
export async function recordAuthEvent(
  db: Pick<Database, 'insert'>,
  type: string,
  severity: 'info' | 'warning' | 'critical',
  subject: string | null,
  detail: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.insert(securityEvents).values({
      type,
      severity,
      siteId: null,
      subject: subject ? subject.slice(0, 200) : null,
      detail,
      meta,
    });
  } catch {
    /* denetim izi best-effort — auth/CRUD akışını bozmaz */
  }
}
