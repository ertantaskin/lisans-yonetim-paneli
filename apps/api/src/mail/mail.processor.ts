import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { type Transporter } from 'nodemailer';
import { DB, type Database } from '../db/db.module';
import { emailLog } from '../db/schema';
import {
  MAIL_DELIVERY_JOB,
  MAIL_NOTICE_JOB,
  MAIL_QUEUE,
  MailService,
  type DeliveryJob,
  type ReplacementNoticeJob,
} from './mail.service';
import { createMailTransport } from './mail.transport';
import { DeliveryMailBuilder } from './delivery-mail.builder';

/** Kuyruktan gelebilecek iş gövdeleri (iş adına göre ayrışır — bkz. process). */
type MailJobData = DeliveryJob | ReplacementNoticeJob;

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
    private readonly config: ConfigService,
    private readonly mail: MailService,
    // Gövde üretimi (şablon + payload çözümü + rehber + sandbox) TEK KAYNAKTAN gelir; aynı
    // sınıfı panel önizlemesi de kullanır → iki yüzey ASLA ayrışamaz (bkz. delivery-mail.builder).
    private readonly builder: DeliveryMailBuilder,
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
      /*
       * Gövde ÜRETİMİ tek kaynaktan (DeliveryMailBuilder): şablon çözümü (§6 ürün+site
       * önceliği), payload çözme, kalem sırası, `{{guides}}` yerleşimi ve sandbox
       * yönlendirmesi burada DEĞİL, builder'da tanımlıdır. Panel önizlemesi AYNI metodu
       * çağırır → operatörün gördüğü metin ile müşteriye giden metin ayrışamaz.
       *
       * reveal: true — müşteri kendi lisansını maskeli alamaz (maskeleme yalnız panel
       * yüzeyinin owner-olmayan admin görünümü içindir).
       */
      const built = await this.builder.build(orderId, { reveal: true });
      if (!built.ok) {
        // Aktif atama yok (ör. tümü revoke edildikten sonra 'Tekrar Mail') → BOŞ mail gönderme.
        await this.setStatus(emailLogId, 'skipped', 'aktif atama yok');
        return;
      }

      const info = await this.mailer().sendMail({
        from: this.config.getOrThrow<string>('MAIL_FROM'),
        to: built.content.to,
        subject: built.content.subject,
        text: built.content.text,
      });

      /*
       * Mail GİTTİ. Log güncellemesi başarısız olsa bile job'ı FAIL etme (retry = mükerrer).
       *
       * AMA SESSİZ OLAMAZ (denetim C6): bu yazım düşerse email_log satırı sonsuza dek
       * 'queued' kalır ve ÜÇ şey birden bozulur —
       *   (a) idempotency kapısı (`existing.status === 'sent'`) AÇILMAZ: aynı iş herhangi bir
       *       sebeple tekrar koşarsa müşteriye LİSANS ANAHTARI TAŞIYAN İKİNCİ mail gider,
       *   (b) satır /ops dead-letter listesinde 'askıda' olarak görünür (yanlış teşhis),
       *   (c) `failedEmails` alarmı bu satırı 'başarısız' saymaz.
       * 'error' KRİTİK seviyede loglanır: bu bir "önemsiz log kaybı" değil, mükerrer teslimat
       * riskidir ve operatörün ARAMASI gereken tek izdir.
       */
      try {
        await this.setStatus(emailLogId, 'sent', null, info.messageId);
      } catch (first) {
        // TEK sınırlı yeniden deneme: gerçek arızaların çoğu anlık bir bağlantı kesintisidir ve
        // idempotency kapısının açık kalmasının bedeli (mükerrer lisans maili) bir ek UPDATE'in
        // maliyetinden kat kat yüksektir. Sınırlı tutulur — teslimat yolu ASLA bloklanmamalı.
        this.logger.warn(
          `email_log 'sent' yazımı başarısız, bir kez daha denenecek (emailLog=${emailLogId}): ${String(first)}`,
        );
        try {
          await this.setStatus(emailLogId, 'sent', null, info.messageId);
        } catch (err) {
          this.logger.error(
            `Mail GÖNDERİLDİ ama email_log 'sent' yazılamadı (emailLog=${emailLogId}, order=${orderId}) — ` +
              `bu kayıt 'queued' kaldı, olası MÜKERRER teslimat maili riski: ${
                err instanceof Error ? err.message : String(err)
              }`,
          );
        }
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
