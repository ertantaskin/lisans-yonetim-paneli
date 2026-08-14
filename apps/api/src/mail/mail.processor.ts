import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { type Transporter } from 'nodemailer';
import { AccountPayloadSchema, parseAccountPayload } from '@lisans/shared';
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
import {
  MAIL_DELIVERY_JOB,
  MAIL_NOTICE_JOB,
  MAIL_QUEUE,
  MailService,
  type DeliveryJob,
  type ReplacementNoticeJob,
} from './mail.service';
import { createMailTransport } from './mail.transport';
import { TemplatesService, render } from './templates.service';

/** Kuyruktan gelebilecek iş gövdeleri (iş adına göre ayrışır — bkz. process). */
type MailJobData = DeliveryJob | ReplacementNoticeJob;

/**
 * Geçerlilik bitişini müşteriye gösterilecek YEREL tarihe çevirir (§11 süreli hesap).
 * Boş/geçersiz değer → '' (şablon token'ı boş kalır, mail bozulmaz — kritik olmayan bir
 * alan yüzünden teslimat maili ASLA düşmemeli). Saat dilimi konteynerden gelir
 * (docker-compose: TZ=Europe/Istanbul) → panelin gösterdiği tarihle aynı gün sınırı.
 */
export function formatValidUntil(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Kalemler arasındaki EN YAKIN (en erken) geçerlilik bitişi; hiç yoksa null. */
export function earliestValidUntil(values: Array<Date | null | undefined>): Date | null {
  let min: Date | null = null;
  for (const v of values) {
    if (!v) continue;
    if (min === null || v.getTime() < min.getTime()) min = v;
  }
  return min;
}

/**
 * BullMQ worker — 'mail' kuyruğunun TEK tüketicisi (§6). Redis kuyruğundan asenkron.
 *
 * Kuyrukta İKİ AYRI iş türü taşınır ve gövdeleri tamamen farklıdır:
 *  - MAIL_DELIVERY_JOB  → siparişin aktif atamalarını çözer, LİSANS ANAHTARLARINI gönderir,
 *  - MAIL_NOTICE_JOB    → değişim/destek DURUM bildirimi; gövde enqueue anında hazırdır, SIRSIZ.
 *
 * DERS (regresyon): iş adları eklenirken bu dallanma UNUTULDUĞU için bildirim işleri teslimat
 * gövdesi sanılıp 'Sipariş bulunamadı' ile başarısız oluyordu → müşteri "talebiniz onaylandı"
 * mailini HİÇ almıyordu. İş adı sabitleri TEK KAYNAKTAN (mail.service) okunur; hem üretici
 * (MailService.enqueue*) hem tüketici (burası) hem /ops replay'i aynı sabitleri kullanır.
 */
// concurrency 5 (varsayılan 1'di): tek sıkışan sendMail (yavaş relay) TÜM mail kuyruğunu baş-blok
// yapmasın — teslimat mailleri + değişim bildirimleri paralel akar. SMTP fail-fast timeout'larıyla
// (mail.transport) birlikte: bir iş en fazla ~20s tutar ve diğer 4 slot bu sırada meşgul değildir.
@Processor(MAIL_QUEUE, { concurrency: 5 })
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);
  private transporter: Transporter | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly templates: TemplatesService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {
    super();
  }

  private mailer(): Transporter {
    // Ortak kurucu (MailService ile tek doğruluk kaynağı) — auth/TLS yapılandırması aynı.
    if (!this.transporter) {
      this.transporter = createMailTransport(this.config);
    }
    return this.transporter;
  }

  /**
   * Kuyruk girişi — İŞ ADINA GÖRE DALLANIR. Gövde tipleri kesişmediği için ad = tek ayraç.
   * Bilinmeyen ad SESSİZCE GEÇİLMEZ (aşağıda gerekçe: sessiz 'completed' = kayıp mail).
   */
  async process(job: Job<MailJobData>): Promise<void> {
    switch (job.name) {
      case MAIL_DELIVERY_JOB:
        // Teslimat işi: davranış AYNEN korunur (payload çözümü + şablon + sandbox).
        return this.processDelivery(job.data as DeliveryJob);
      case MAIL_NOTICE_JOB:
        // Bildirim işi: worker HİÇBİR ŞEY çözmez (atama/payload okumaz) — konu/gövde işin
        // kendi içinden gelir, teslimat şablonu KULLANILMAZ → lisans anahtarı sızma yüzeyi yok.
        return this.mail.sendNoticeJob(job.data as ReplacementNoticeJob);
      default:
        return this.processUnknown(job);
    }
  }

  /**
   * Tanınmayan iş adı — HATA FIRLATILIR (sessiz 'completed' YASAK).
   *
   * Sessiz geçilseydi: iş başarılı sayılır, email_log satırı sonsuza dek 'queued' kalır ve
   * /ops dead-letter listesinde GÖRÜNMEZ → mail kaybı fark edilmez (bu görevi doğuran regresyonun
   * ta kendisi). Fırlatmak BullMQ retry/dead-letter zincirini devreye sokar; log kaydı da düşer.
   */
  private async processUnknown(job: Job<MailJobData>): Promise<never> {
    const message = `Bilinmeyen mail işi adı: '${String(job.name)}' (job=${job.id ?? '-'})`;
    this.logger.error(message);
    // email_log'u da 'failed' işaretle (best-effort): kayıt /ops dead-letter'da yüzeye çıksın.
    const emailLogId = (job.data as Partial<DeliveryJob> | undefined)?.emailLogId;
    if (typeof emailLogId === 'string' && emailLogId.length > 0) {
      await this.setStatus(emailLogId, 'failed', message).catch(() => undefined);
    }
    throw new Error(message);
  }

  /** Teslimat maili (MAIL_DELIVERY_JOB) — siparişin aktif atamalarını çözüp gönderir. */
  private async processDelivery(data: DeliveryJob): Promise<void> {
    const { orderId, emailLogId } = data;

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
          // Geçerlilik bitişi (süreli hesap ürünü, §11). Süzgeçte KULLANILIYORDU ama
          // SEÇİLMİYORDU → şablona `{{valid_until}}` yazan operatör sessizce boş string
          // alıyordu; müşteri geçerlilik tarihini My Account'ta görüyor, MAİLDE göremiyordu.
          validUntil: assignments.validUntil,
          payloadEnc: licenseItems.payloadEnc,
          licenseItemId: licenseItems.id,
          productName: products.name,
          productId: orderLines.productId,
          productKind: products.kind,
          payloadSchema: products.payloadSchema,
        })
        .from(assignments)
        .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
        .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
        .leftJoin(products, eq(orderLines.productId, products.id))
        .where(
          and(
            eq(assignments.orderId, orderId),
            eq(assignments.status, 'active'),
            // #7 denetim (yarış savunması) — getDeliveries ile SİMETRİK: iptal/iade edilmiş
            // satırın (canceled) ataması ASLA maile girmez. getDeliveries bu yüklemi AÇIK bir
            // savunma olarak taşıyordu, mail `orderLines`'ı join ettiği hâlde KOYMUYORDU →
            // stray aktif atama kalırsa My Account anahtarı gizlerken "Tekrar Mail" AYNI
            // anahtarı DÜZ METİN e-postayla gönderiyordu (okuma yolu yazma yolundan iyi korunuyordu).
            eq(orderLines.canceled, false),
            // Savunma amaçlı süre filtresi (getDeliveries ile birebir aynı invaryant):
            // expiry job gecikse bile onExpiry='hide' ürünün süresi geçmiş payload'ı
            // mail gövdesine KONULMAZ (düz metin parola sızmaz). 'keep' ürün süre
            // sonrası da teslim edilir.
            or(
              isNull(assignments.validUntil),
              gt(assignments.validUntil, sql`now()`),
              eq(products.onExpiry, 'keep'),
            ),
          ),
        )
        // SIRA: mail gövdesindeki anahtarlar da stoğa giriş sırasında (getDeliveries ile
        // AYNI yön). ORDER BY yoktu → müşteriye giden mailde sıra rastgeleydi ve panelde
        // görünen sırayla tutmuyordu.
        .orderBy(licenseItems.seq);

      // Aktif atama yoksa (ör. tümü revoke edildikten sonra resend) BOŞ mail gönderme.
      if (rows.length === 0) {
        await this.setStatus(emailLogId, 'skipped', 'aktif atama yok');
        return;
      }

      const itemsBlock = rows
        .map((r) => {
          const plain = this.crypto.decrypt(
            r.payloadEnc,
            CryptoService.licenseItemAad(r.licenseItemId),
          );
          const label = r.productName ?? 'Ürün';
          const qty = r.units > 1 ? ` (${r.units} adet)` : '';
          // Geçerlilik bitişi kaleme YAZILIR: süreli hesap ürününde tarih müşterinin en çok
          // ihtiyaç duyduğu bilgidir ve çok kalemli siparişte kalemler FARKLI tarihler taşır
          // → tek bir {{valid_until}} değişkeni bunu doğru anlatamaz (o değişken yalnız en
          // yakın tarihi verir, aşağıya bkz.).
          const until = formatValidUntil(r.validUntil);
          const untilLine = until ? `\n    Geçerlilik bitişi: ${until}` : '';
          // Hesap ürünü: alan-alan render (Kullanıcı adı: x / Parola: y).
          const schema =
            r.productKind === 'account' ? AccountPayloadSchema.safeParse(r.payloadSchema) : null;
          if (schema?.success) {
            const fields = parseAccountPayload(schema.data, plain)
              .map((f) => `    ${f.label}: ${f.value}`)
              .join('\n');
            return `• ${label}${qty}:\n${fields}${untilLine}`;
          }
          return `• ${label}${qty}: ${plain}${untilLine}`;
        })
        .join('\n');

      // Şablon: ilk satırın ürününe göre (site override > ürün > varsayılan, §6).
      const tpl = await this.templates.resolve(rows[0]!.productId, order.siteId);
      const vars = {
        order_no: order.remoteOrderId,
        site_name: site?.domain ?? 'Mağaza',
        product_name: rows[0]!.productName ?? '',
        units: String(rows.reduce((s, r) => s + r.units, 0)),
        customer_email: order.customerEmail,
        items: itemsBlock,
        // Süreli hesap (§11) geçerlilik bitişi. Siparişteki EN YAKIN tarih seçilir: birden çok
        // kalem farklı tarihler taşıyabilir ve tek değişkene sığmaz; "en erken biten" müşteri
        // için en güvenli özettir (kalem kalem doğru tarih zaten `{{items}}` bloğunda yazılıdır).
        // Süresiz üründe BOŞ string (şablon token'ı sessizce kaybolur — mevcut render davranışı).
        valid_until: formatValidUntil(earliestValidUntil(rows.map((r) => r.validUntil))),
      };

      // Sandbox (test modu, §14): site.sandbox=true ise gerçek müşteriye mail GİTMEZ —
      // alıcı yöneticiye (MAIL_FROM) yönlendirilir + konu başına '[TEST MODU] ' eklenir.
      const mailFrom = this.config.getOrThrow<string>('MAIL_FROM');
      const sandbox = site?.sandbox === true;
      const subject = render(tpl.subject, vars);

      const info = await this.mailer().sendMail({
        from: mailFrom,
        to: sandbox ? mailFrom : order.customerEmail,
        subject: sandbox ? `[TEST MODU] ${subject}` : subject,
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
