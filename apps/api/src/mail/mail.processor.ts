import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import nodemailer, { type Transporter } from 'nodemailer';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import {
  assignments,
  emailLog,
  licenseItems,
  orderLines,
  orders,
  products,
  sites,
} from '../db/schema';
import { MAIL_QUEUE, type DeliveryJob } from './mail.service';
import { TemplatesService, render } from './templates.service';

/** BullMQ worker — teslimat maili gönderimi (§6). Redis kuyruğundan asenkron. */
@Processor(MAIL_QUEUE)
export class MailProcessor extends WorkerHost {
  private transporter: Transporter | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly templates: TemplatesService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  private mailer(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.getOrThrow<string>('SMTP_HOST'),
        port: this.config.getOrThrow<number>('SMTP_PORT'),
        // Üretimde SMTP_SECURE=true (TLS); dev Mailpit TLS'siz.
        secure: this.config.get<boolean>('SMTP_SECURE') ?? false,
      });
    }
    return this.transporter;
  }

  async process(job: Job<DeliveryJob>): Promise<void> {
    const { orderId, emailLogId } = job.data;

    // Idempotency: bu log zaten gönderildiyse retry'da tekrar GÖNDERME (mükerrer mail engeli).
    const [existing] = await this.db
      .select({ status: emailLog.status })
      .from(emailLog)
      .where(eq(emailLog.id, emailLogId))
      .limit(1);
    if (existing?.status === 'sent') return;

    try {
      const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new Error('Sipariş bulunamadı');

      const [site] = await this.db.select().from(sites).where(eq(sites.id, order.siteId)).limit(1);

      const rows = await this.db
        .select({
          units: assignments.units,
          payloadEnc: licenseItems.payloadEnc,
          productName: products.name,
          productId: orderLines.productId,
        })
        .from(assignments)
        .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
        .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
        .leftJoin(products, eq(orderLines.productId, products.id))
        .where(and(eq(assignments.orderId, orderId), eq(assignments.status, 'active')));

      // Aktif atama yoksa (ör. tümü revoke edildikten sonra resend) BOŞ mail gönderme.
      if (rows.length === 0) {
        await this.setStatus(emailLogId, 'skipped', 'aktif atama yok');
        return;
      }

      const itemsBlock = rows
        .map((r) => {
          const payload = this.crypto.decrypt(r.payloadEnc);
          const label = r.productName ?? 'Ürün';
          const qty = r.units > 1 ? ` (${r.units} adet)` : '';
          return `• ${label}${qty}: ${payload}`;
        })
        .join('\n');

      // Şablon: ilk satırın ürününe göre (site override > ürün > varsayılan, §6).
      const tpl = await this.templates.resolve(rows[0]!.productId, order.siteId);
      const vars = {
        order_no: order.remoteOrderId,
        site_name: site?.domain ?? 'Jetlisans',
        product_name: rows[0]!.productName ?? '',
        units: String(rows.reduce((s, r) => s + r.units, 0)),
        customer_email: order.customerEmail,
        items: itemsBlock,
      };

      const info = await this.mailer().sendMail({
        from: this.config.getOrThrow<string>('MAIL_FROM'),
        to: order.customerEmail,
        subject: render(tpl.subject, vars),
        text: render(tpl.body, vars),
      });

      // Mail GİTTİ. Log güncellemesi başarısız olsa bile job'ı FAIL etme (retry = mükerrer).
      try {
        await this.setStatus(emailLogId, 'sent', null, info.messageId);
      } catch {
        // yut — mail gönderildi, log güncellemesi kritik değil
      }
    } catch (err) {
      await this.setStatus(emailLogId, 'failed', err instanceof Error ? err.message : String(err));
      throw err; // gönderilmeden önceki hata → BullMQ tekrar dener
    }
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
