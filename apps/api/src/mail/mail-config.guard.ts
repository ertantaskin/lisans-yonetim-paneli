import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * DEV mail yakalayıcıları (gerçek posta KUTUSUNA teslim ETMEZ; SMTP'yi kabul edip 250 döner).
 * `mailpit` compose'daki servis adı, diğerleri yaygın yerel kurulum (MailHog/Mailcatcher/relay-yok).
 */
const DEV_MAIL_SINKS = new Set(['mailpit', 'mailhog', 'mailcatcher', 'localhost', '127.0.0.1', '::1']);

/**
 * SMTP hedefi gerçek bir posta relay'i mi, yoksa dev yakalayıcı mı?
 * Tek doğruluk kaynağı — hem boot guard'ı hem /v1/health hem admin /settings bunu kullanır
 * (aynı kavramın iki farklı yüklemi = tutarsız rapor; [[denetim-regresyon-dersleri]] #14).
 */
export function isDevMailSink(host: string | undefined | null): boolean {
  return DEV_MAIL_SINKS.has(String(host ?? '').trim().toLowerCase());
}

/**
 * SESSİZ MAİL ARIZASI GUARD'I (denetim bulgusu).
 *
 * `SMTP_HOST` varsayılanı `mailpit` ve mailpit servisi PROD compose'da da ayakta. Operatör
 * `.env`'e gerçek relay yazmayı unutursa: nodemailer 250 OK alır → `email_log` 'sent' olur →
 * panelde HER ŞEY YEŞİL görünür, ama müşteri lisans mailini ASLA almaz. Tespit ancak müşteri
 * şikâyetiyle gelir; "test maili gönder" bile YANLIŞ güven verir (mailpit de 250 döner).
 *
 * Bu yüzden ÜRETİMDE (NODE_ENV=production) hedef bir dev yakalayıcıysa açılışta GÜRÜLTÜ çıkar:
 * logger.error + kritik bildirim (panel bildirim akışı + env-gated Telegram).
 *
 * FAIL-CLOSED DEĞİL (bilinçli): boot'u durdurmak, hâlihazırda çalışan bir kurulumu mail
 * yapılandırması yüzünden komple indirirdi — oysa mail TEK teslimat kanalı değildir (müşteri
 * My Account'ta anahtarı görür, geri-kanal webhook siparişe yazar, operatör "Tekrar Mail" ile
 * kurtarır). Sinyal ver, sistemi kırma.
 */
@Injectable()
export class MailConfigGuardService implements OnModuleInit {
  private readonly logger = new Logger(MailConfigGuardService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const host = this.config.get<string>('SMTP_HOST');
    const isProd = (this.config.get<string>('NODE_ENV') ?? '') === 'production';
    if (!isProd || !isDevMailSink(host)) return;

    const title = 'Mail yapılandırması: gerçek relay TANIMLI DEĞİL';
    const message =
      `SMTP_HOST='${host}' bir DEV yakalayıcısı — mailler gerçek müşteriye ULAŞMIYOR ` +
      `(kayıtlar yine 'gönderildi' görünür). .env'e gerçek relay yazın: ` +
      `SMTP_HOST/SMTP_PORT/SMTP_SECURE (+ gerekiyorsa SMTP_USER/SMTP_PASS) ve api'yi yeniden başlatın.`;
    this.logger.error(`${title} — ${message}`);
    // best-effort: bildirim yazımı başarısız olsa da boot DEVAM eder (alarm, kapı değil).
    try {
      await this.notifications.create({
        type: 'mail_config',
        severity: 'critical',
        title,
        message,
      });
    } catch (err) {
      this.logger.warn(`Mail yapılandırma uyarısı bildirime yazılamadı: ${(err as Error).message}`);
    }
  }
}
