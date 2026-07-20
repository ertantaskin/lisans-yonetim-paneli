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
        secure: false,
      });
    }
    return this.transporter;
  }

  async process(job: Job<DeliveryJob>): Promise<void> {
    const { orderId, emailLogId } = job.data;
    try {
      const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new Error('Sipariş bulunamadı');

      const [site] = await this.db.select().from(sites).where(eq(sites.id, order.siteId)).limit(1);

      const rows = await this.db
        .select({
          units: assignments.units,
          payloadEnc: licenseItems.payloadEnc,
          productName: products.name,
        })
        .from(assignments)
        .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
        .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
        .leftJoin(products, eq(orderLines.productId, products.id))
        .where(and(eq(assignments.orderId, orderId), eq(assignments.status, 'active')));

      const itemsBlock = rows
        .map((r) => {
          const payload = this.crypto.decrypt(r.payloadEnc);
          const label = r.productName ?? 'Ürün';
          const qty = r.units > 1 ? ` (${r.units} adet)` : '';
          return `• ${label}${qty}: ${payload}`;
        })
        .join('\n');

      const productId = rows.length > 0 ? null : null; // varsayılan şablon yeterli (MVP)
      const tpl = await this.templates.resolve(productId, order.siteId);
      const vars = {
        order_no: order.remoteOrderId,
        site_name: site?.domain ?? 'Jetlisans',
        customer_email: order.customerEmail,
        items: itemsBlock,
      };

      const info = await this.mailer().sendMail({
        from: this.config.getOrThrow<string>('MAIL_FROM'),
        to: order.customerEmail,
        subject: render(tpl.subject, vars),
        text: render(tpl.body, vars),
      });

      await this.db
        .update(emailLog)
        .set({ status: 'sent', providerMessageId: info.messageId, updatedAt: new Date() })
        .where(eq(emailLog.id, emailLogId));
    } catch (err) {
      await this.db
        .update(emailLog)
        .set({
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          updatedAt: new Date(),
        })
        .where(eq(emailLog.id, emailLogId));
      throw err; // BullMQ tekrar dener
    }
  }
}
