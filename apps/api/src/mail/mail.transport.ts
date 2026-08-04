import type { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Tek doğruluk kaynağı SMTP transporter kurucusu — teslimat maili (MailProcessor) VE değişim/
 * garanti durum bildirimi (MailService) AYNI yapılandırmayı kullanır. Daha önce iki ayrı kurucu
 * vardı ve MailService auth bloğunu ATLIYORDU → kimlik-doğrulamalı relay'de (üretim: SMTP_USER/
 * SMTP_PASS dolu) değişim bildirimleri 530/535 'auth required' ile sessizce 'failed' oluyordu
 * (dev Mailpit'te auth olmadığı için tüm testlerden geçip yalnız üretimde patlayan regresyon).
 * Tek kurucu bu davranış sapmasını kalıcı keser.
 */
export function createMailTransport(config: ConfigService): Transporter {
  const user = config.get<string>('SMTP_USER');
  const pass = config.get<string>('SMTP_PASS');
  return nodemailer.createTransport({
    host: config.getOrThrow<string>('SMTP_HOST'),
    port: config.getOrThrow<number>('SMTP_PORT'),
    // Üretimde SMTP_SECURE=true (TLS); dev Mailpit TLS'siz.
    secure: config.get<boolean>('SMTP_SECURE') ?? false,
    // Kimlik verildiyse auth ekle (gerçek relay); yoksa kimliksiz (dev Mailpit).
    ...(user ? { auth: { user, pass: pass ?? '' } } : {}),
    // FAIL-FAST timeout'lar (dayanıklılık): sistemdeki diğer TÜM dış çağrıların kısa timeout'u
    // var (Redis commandTimeout 2s, PG statement_timeout 30s, webhook AbortSignal 10s) — SMTP bu
    // kalkanın tek deliğiydi. nodemailer varsayılanları çok uzun (connect ~2dk, socket ~10dk);
    // relay TCP'yi kabul edip yanıtı black-hole yaparsa (ağ kesintisi/relay askısı) her sıkışan
    // iş mail worker'ını dakikalarca tutar ve teslimat mailleri (çekirdek ürün) TÜM müşteriler
    // için kuyrukta bekler. Kısa timeout → hızlı-başarısız → BullMQ retry/backoff devreye girer.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}
