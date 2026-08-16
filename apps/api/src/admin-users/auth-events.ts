import { Logger } from '@nestjs/common';
import type { Database } from '../db/db.module';
import { securityEvents } from '../db/schema/securityEvents';

/**
 * NEDEN LOGGER (denetim C2): bu yazıcı brute-force görünürlüğünün TEK kaynağıdır — başarısız
 * girişler yalnız buradan `security_events`'e düşer. Yazım sessizce yutulursa saldırı anında
 * /security ekranı BOŞ kalır ve operatör "deneme yok" sanır; en çok ihtiyaç duyulan anda
 * (DB baskı altında, disk dolu, kolon sapması) tam olarak bu yazım başarısız olur.
 * Best-effort davranış DEĞİŞMEZ (auth akışı asla bozulmaz) — yalnız arıza GÖRÜNÜR olur.
 */
const logger = new Logger('AuthEvents');

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
  } catch (err) {
    // Best-effort korunur (fırlatmaz) ama SESSİZ DEĞİL: aksi halde güvenlik izinin kaybı,
    // tam da izleme ihtiyacının en yüksek olduğu anda hiçbir iz bırakmadan gerçekleşirdi.
    // SIR yazılmaz: yalnız olay tipi + özne (e-posta/kullanıcı adı, zaten subject alanı).
    logger.error(
      `Güvenlik olayı yazılamadı (type=${type}, subject=${subject ?? '-'}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
