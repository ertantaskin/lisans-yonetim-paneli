import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import nodemailer, { type Transporter } from 'nodemailer';
import { DB, type Database } from '../db/db.module';
import { emailLog, orders, sites } from '../db/schema';

export const MAIL_QUEUE = 'mail';

export interface DeliveryJob {
  orderId: string;
  emailLogId: string;
}

/** Değişim/garanti talebi durum bildiriminde kullanılan durum kodları. */
export type ReplacementNoticeStatus = 'rejected' | 'info_requested' | string;

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  /**
   * Teslimat mailini kuyruğa alır (§2: mail asenkron; sağlayıcı çökse bile atama
   * tamamdır, kuyruk tekrar dener). email_log 'queued' oluşturulur.
   */
  async enqueueDelivery(orderId: string, toEmail: string, subject: string): Promise<void> {
    const [log] = await this.db
      .insert(emailLog)
      .values({ orderId, toEmail, subject, status: 'queued' })
      .returning({ id: emailLog.id });

    await this.queue.add('delivery', { orderId, emailLogId: log!.id } satisfies DeliveryJob, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  /**
   * Değişim/garanti talebi DURUM bildirimini müşteriye gönderir (§13).
   *
   * NOT: teslimat kuyruğu (MailProcessor) yalnız lisans payload'ı çözüp gönderir —
   * bir "durum bildirimi" oraya konulursa (a) şablon tüm aktif atamaların GERÇEK
   * anahtarını yeniden yollar, (b) sır düz metne dönerdi. Bu yüzden bildirim SIR
   * İÇERMEZ ve ayrı, doğrudan gönderilir: yalnız durum + çözüm notu. Gönderim
   * best-effort'tur — SMTP hatası admin aksiyonunu (reject/request-info) BOZMAZ,
   * email_log'a 'failed' düşer.
   */
  async enqueueReplacementNotice(
    orderId: string,
    toEmail: string,
    status: ReplacementNoticeStatus,
    note?: string | null,
  ): Promise<void> {
    // Sipariş no + sandbox için siparişi/siteyi çöz (yoksa yine gönderilir).
    const [order] = await this.db
      .select({ remoteOrderId: orders.remoteOrderId, siteId: orders.siteId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    let sandbox = false;
    let siteName = 'Jetlisans';
    if (order?.siteId) {
      const [site] = await this.db
        .select({ sandbox: sites.sandbox, domain: sites.domain })
        .from(sites)
        .where(eq(sites.id, order.siteId))
        .limit(1);
      sandbox = site?.sandbox === true;
      siteName = site?.domain ?? siteName;
    }

    const orderNo = order?.remoteOrderId ?? orderId;
    const headline = this.replacementHeadline(status);
    const subject = `Değişim talebiniz — ${orderNo}`;
    const bodyLines = [
      'Merhaba,',
      '',
      `${orderNo} numaralı siparişinizdeki değişim/garanti talebiniz güncellendi:`,
      '',
      headline,
    ];
    if (note && note.trim().length > 0) {
      bodyLines.push('', `Not: ${note.trim()}`);
    }
    bodyLines.push('', 'İyi günler,', siteName);
    const body = bodyLines.join('\n');

    // email_log kaydı (durum bildirimi de gönderim izine düşer, §9).
    const [log] = await this.db
      .insert(emailLog)
      .values({ orderId, toEmail, subject, status: 'queued' })
      .returning({ id: emailLog.id });

    // Sandbox (test modu, §14): gerçek müşteriye GİTMEZ — yöneticiye yönlendirilir.
    try {
      const mailFrom = this.config.getOrThrow<string>('MAIL_FROM');
      const info = await this.mailer().sendMail({
        from: mailFrom,
        to: sandbox ? mailFrom : toEmail,
        subject: sandbox ? `[TEST MODU] ${subject}` : subject,
        text: body,
      });
      await this.setStatus(log!.id, 'sent', null, info.messageId);
    } catch (err) {
      // Bildirim gönderimi admin aksiyonunu bozmaz — sadece logla.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Değişim bildirimi gönderilemedi (order=${orderId}): ${message}`);
      await this.setStatus(log!.id, 'failed', message).catch(() => undefined);
    }
  }

  private replacementHeadline(status: ReplacementNoticeStatus): string {
    switch (status) {
      case 'rejected':
        return 'Talebiniz incelendi ve bu kez onaylanmadı.';
      case 'info_requested':
        return 'Talebinizi değerlendirebilmemiz için ek bilgiye ihtiyacımız var.';
      default:
        return 'Talebinizin durumu güncellendi.';
    }
  }

  private mailer(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.getOrThrow<string>('SMTP_HOST'),
        port: this.config.getOrThrow<number>('SMTP_PORT'),
        secure: this.config.get<boolean>('SMTP_SECURE') ?? false,
      });
    }
    return this.transporter;
  }

  private async setStatus(
    id: string,
    status: string,
    error: string | null,
    providerMessageId?: string,
  ): Promise<void> {
    await this.db
      .update(emailLog)
      .set({ status, error, providerMessageId, updatedAt: new Date() })
      .where(eq(emailLog.id, id));
  }
}
