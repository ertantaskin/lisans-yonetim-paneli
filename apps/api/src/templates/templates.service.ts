import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { desc, eq } from 'drizzle-orm';
import nodemailer, { type Transporter } from 'nodemailer';
import { DB, type Database } from '../db/db.module';
import { deliveryTemplates, emailLog, products, sites } from '../db/schema';

/**
 * {{degisken}} token değişimi (§6). mail/templates.service.ts'teki render ile birebir
 * aynı davranış — bu modül mail modülünü DÜZENLEMEZ, kendi kopyasını tutar (bağımsız).
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}

/** Önizleme/test için varsayılan örnek değişkenler (§6 token seti). */
export const SAMPLE_VARS: Record<string, string> = {
  order_no: '10042',
  site_name: 'jetlisans.com',
  product_name: 'Windows 11 Pro',
  units: '1',
  customer_email: 'musteri@ornek.com',
  items: '• Windows 11 Pro: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX',
};

export interface TemplateInput {
  subject: string;
  body: string;
  productId?: string | null;
  siteId?: string | null;
}

export interface TemplateRow {
  id: string;
  subject: string;
  body: string;
  productId: string | null;
  siteId: string | null;
  productName: string | null;
  siteDomain: string | null;
  createdAt: Date;
}

/**
 * Admin teslimat şablonu (delivery_templates) yönetimi (§6/§13). CRUD + önizleme +
 * test-mail. Öncelik çözümü (site override > ürün > varsayılan) mail modülünde;
 * bu servis yalnız şablon kayıtlarını yönetir ve tek-seferlik test maili gönderir.
 */
@Injectable()
export class DeliveryTemplatesService {
  private transporter: Transporter | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  /** Tüm şablonlar — ürün adı + site domain ile zenginleştirilmiş (en yeni önce). */
  async list(): Promise<TemplateRow[]> {
    const rows = await this.db
      .select({
        id: deliveryTemplates.id,
        subject: deliveryTemplates.subject,
        body: deliveryTemplates.body,
        productId: deliveryTemplates.productId,
        siteId: deliveryTemplates.siteId,
        productName: products.name,
        siteDomain: sites.domain,
        createdAt: deliveryTemplates.createdAt,
      })
      .from(deliveryTemplates)
      .leftJoin(products, eq(deliveryTemplates.productId, products.id))
      .leftJoin(sites, eq(deliveryTemplates.siteId, sites.id))
      .orderBy(desc(deliveryTemplates.createdAt));
    return rows;
  }

  async get(id: string): Promise<TemplateRow> {
    const [row] = await this.db
      .select({
        id: deliveryTemplates.id,
        subject: deliveryTemplates.subject,
        body: deliveryTemplates.body,
        productId: deliveryTemplates.productId,
        siteId: deliveryTemplates.siteId,
        productName: products.name,
        siteDomain: sites.domain,
        createdAt: deliveryTemplates.createdAt,
      })
      .from(deliveryTemplates)
      .leftJoin(products, eq(deliveryTemplates.productId, products.id))
      .leftJoin(sites, eq(deliveryTemplates.siteId, sites.id))
      .where(eq(deliveryTemplates.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Şablon bulunamadı');
    return row;
  }

  async create(input: TemplateInput): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(deliveryTemplates)
      .values({
        subject: input.subject,
        body: input.body,
        productId: input.productId ?? null,
        siteId: input.siteId ?? null,
      })
      .returning({ id: deliveryTemplates.id });
    return { id: row!.id };
  }

  /** Yalnız verilen alanlar güncellenir. Yoksa 404. */
  async update(id: string, input: Partial<TemplateInput>): Promise<TemplateRow> {
    await this.get(id); // yoksa 404

    const patch: Partial<typeof deliveryTemplates.$inferInsert> = {};
    if (input.subject !== undefined) patch.subject = input.subject;
    if (input.body !== undefined) patch.body = input.body;
    if (input.productId !== undefined) patch.productId = input.productId;
    if (input.siteId !== undefined) patch.siteId = input.siteId;

    if (Object.keys(patch).length > 0) {
      await this.db.update(deliveryTemplates).set(patch).where(eq(deliveryTemplates.id, id));
    }
    return this.get(id);
  }

  async remove(id: string): Promise<{ ok: true }> {
    const [row] = await this.db
      .delete(deliveryTemplates)
      .where(eq(deliveryTemplates.id, id))
      .returning({ id: deliveryTemplates.id });
    if (!row) throw new NotFoundException('Şablon bulunamadı');
    return { ok: true };
  }

  /**
   * Şablonu örnek değişkenlerle render eder (GÖNDERİM YOK) — konu + gövde döner (§6).
   * sampleVars verilirse varsayılanların üzerine yazılır.
   */
  async preview(
    id: string,
    sampleVars?: Record<string, string>,
  ): Promise<{ subject: string; body: string }> {
    const tpl = await this.get(id);
    const vars = { ...SAMPLE_VARS, ...(sampleVars ?? {}) };
    return { subject: renderTemplate(tpl.subject, vars), body: renderTemplate(tpl.body, vars) };
  }

  private mailer(): Transporter {
    if (!this.transporter) {
      const user = this.config.get<string>('SMTP_USER');
      const pass = this.config.get<string>('SMTP_PASS');
      this.transporter = nodemailer.createTransport({
        host: this.config.getOrThrow<string>('SMTP_HOST'),
        port: this.config.getOrThrow<number>('SMTP_PORT'),
        secure: this.config.get<boolean>('SMTP_SECURE') ?? false,
        // Kimlik verildiyse auth ekle (gerçek relay); yoksa kimliksiz (dev Mailpit).
        ...(user ? { auth: { user, pass: pass ?? '' } } : {}),
      });
    }
    return this.transporter;
  }

  /**
   * Şablonu örnek değişkenlerle render edip tek-seferlik TEST maili gönderir (§6). Çekirdek
   * teslimat kuyruğu sipariş-güdümlüdür (order+atama gerektirir) ve keyfi şablon render'ı
   * desteklemez; bu yüzden test maili burada mevcut SMTP yapılandırmasıyla doğrudan gönderilir.
   * Gerçek müşteri verisi kullanılmaz (SAMPLE_VARS). email_log'a iz düşer (orderId=null).
   */
  async sendTest(id: string, toEmail: string): Promise<{ ok: boolean; error?: string }> {
    const { subject, body } = await this.preview(id);
    const mailFrom = this.config.getOrThrow<string>('MAIL_FROM');
    const testSubject = `[TEST] ${subject}`;

    const [log] = await this.db
      .insert(emailLog)
      .values({ orderId: null, toEmail, subject: testSubject, status: 'queued' })
      .returning({ id: emailLog.id });

    try {
      const info = await this.mailer().sendMail({
        from: mailFrom,
        to: toEmail,
        subject: testSubject,
        text: body,
      });
      await this.db
        .update(emailLog)
        .set({ status: 'sent', providerMessageId: info.messageId, updatedAt: new Date() })
        .where(eq(emailLog.id, log!.id));
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(emailLog)
        .set({ status: 'failed', error: message, updatedAt: new Date() })
        .where(eq(emailLog.id, log!.id));
      return { ok: false, error: message };
    }
  }
}
