import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminGuard } from '../auth/admin.guard';
import { isDevMailSink } from '../mail/mail-config.guard';

/**
 * ADMIN-ONLY sistem yapılandırma yansıması (§16 gözlem).
 *
 * NEDEN AYRI UÇ: Bu bayraklar API konteynerinin env'inden gelir; admin (Next) konteyneri onları
 * GÖREMEZ — /settings ekranı bu yüzden Telegram'ı HER ZAMAN "kapalı" gösteriyordu (yanlış bilgi:
 * operatör alarmların çalıştığını sanıyor ya da boşuna arıyor). Public /v1/health'e KOYULMADI:
 * bir kurulumun alarm/mail yapılandırmasını dışarıya sızdırmak gereksiz bilgi ifşasıdır.
 *
 * KRİTİK: yalnız BOOLEAN döner — token/DSN/anahtar DEĞERİ ASLA dönmez.
 */
@Controller('admin/system')
@UseGuards(AdminGuard)
export class SystemStatusController {
  constructor(private readonly config: ConfigService) {}

  private isSet(name: string): boolean {
    const v = this.config.get<string>(name);
    return typeof v === 'string' && v.trim().length > 0;
  }

  @Get('status')
  status() {
    return {
      /**
       * Mail GERÇEK bir relay'e mi gidiyor? false = dev yakalayıcı (mailpit/localhost):
       * SMTP 250 döner, email_log 'sent' olur ama müşteri maili ASLA almaz.
       */
      mailRelay: !isDevMailSink(this.config.get<string>('SMTP_HOST')),
      /** Kimlik doğrulamalı relay mi (SMTP_USER dolu). */
      mailAuth: this.isSet('SMTP_USER'),
      /** Telegram alarm kanalı (bot token + chat id BİRLİKTE) aktif mi. */
      telegram: this.isSet('TELEGRAM_BOT_TOKEN') && this.isSet('TELEGRAM_CHAT_ID'),
      /** Sentry hata izleme (SENTRY_DSN) aktif mi. */
      sentry: this.isSet('SENTRY_DSN'),
      /** AI-destekli operasyon (§15) aktif mi — AI_ENABLED=true VE anahtar tanımlı. */
      ai: String(this.config.get<string>('AI_ENABLED') ?? '').toLowerCase() === 'true'
        && this.isSet('ANTHROPIC_API_KEY'),
    };
  }
}
