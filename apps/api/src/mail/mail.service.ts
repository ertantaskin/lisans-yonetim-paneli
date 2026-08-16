import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { type Transporter } from 'nodemailer';
import { DB, type Database } from '../db/db.module';
import { emailLog, orders, sites } from '../db/schema';
import { createMailTransport } from './mail.transport';

export const MAIL_QUEUE = 'mail';

/**
 * Mail kuyruğundaki İŞ ADLARI (TEK KAYNAK — üretici de tüketici de buradan okur).
 *
 * İki tür AYNI kuyrukta taşınır ama GÖVDELERİ tamamen farklıdır:
 *  - 'delivery' → siparişin AKTİF atamalarını çözüp LİSANS ANAHTARLARINI gönderir (MailProcessor),
 *  - 'replacement-notice' → yalnız DURUM metni gönderir (sır İÇERMEZ, gövde enqueue anında hazırdır).
 *
 * Tüketici: MailProcessor.process — `job.name` ile DALLANIR (delivery → kendi akışı,
 * replacement-notice → MailService.sendNoticeJob, bilinmeyen → hata fırlatır). Sabitler burada
 * durduğu sürece üretici/tüketici adları BİR DAHA ayrışamaz (ayrıştığında bildirim mailleri
 * sessizce kaybolmuştu — regresyon dersi). Yeni bir iş adı eklenirse MailProcessor'a dalı da EKLE.
 */
export const MAIL_DELIVERY_JOB = 'delivery';
export const MAIL_NOTICE_JOB = 'replacement-notice';

/**
 * Kuyruk yeniden-deneme profili — teslimat ve bildirim AYNI garantiyi paylaşır
 * (attempts/backoff/removeOnComplete/removeOnFail tek yerde; iki yol arasında sapma olmasın).
 */
export const MAIL_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export interface DeliveryJob {
  orderId: string;
  emailLogId: string;
}

/**
 * Değişim/destek DURUM bildirimi işi. Gövde enqueue anında ÜRETİLİR (worker hiçbir şey çözmez).
 *
 * DİKKAT — `orderId` alanı BİLEREK YOKTUR: DeliveryJob ile aynı anahtar adını taşısaydı, işi
 * adıyla ayırmayan bir worker bunu teslimat işi sanıp müşteriye TÜM lisans anahtarlarını
 * yollardı (veri sızıntısı sınıfı; /ops replay'inde aynısı bulundu). Sipariş bağı yalnız
 * email_log satırında durur.
 */
export interface ReplacementNoticeJob {
  emailLogId: string;
  /** Nihai alıcı — sandbox yönlendirmesi ENQUEUE anında karara bağlanır (worker sade kalır). */
  to: string;
  subject: string;
  body: string;
}

/**
 * enqueueReplacementNotice sonucu — "bildirildi" bayrağı bundan türetilmeli (dürüst rapor).
 *
 * ANLAM SINIRI: `queued=true` yalnız "KUYRUĞA ALINDI" demektir, "GÖNDERİLDİ" DEĞİL. Gerçek
 * gönderim sonucunu işleyici (MailProcessor → sendNoticeJob) email_log satırına yazar
 * ('sent' / 'failed'); UI'da "gönderildi" iddiası gerekiyorsa kaynak email_log'dur.
 * Çağıran bayrağı `queued` alanından türetmeli — promise'in çözülmesinden DEĞİL (bu metot
 * hata durumunda da normal döner; `.then(() => true)` her zaman true verir ve YANILTIR).
 */
export interface NoticeEnqueueResult {
  /** true → kuyruğa alındı (kalıcı: geçici SMTP hatasında tekrar denenir). Gönderildi DEĞİL. */
  queued: boolean;
  /** email_log satırı (yazılabildiyse) — takip/dead-letter için. */
  emailLogId: string | null;
  /** queued=false ise sebep (log/UI için; sır içermez). */
  error?: string;
}

/** Değişim/garanti talebi durum bildiriminde kullanılan durum kodları. */
export type ReplacementNoticeStatus = 'approved' | 'rejected' | 'info_requested' | string;

/**
 * Değişim/destek DURUM bildirimi konusunun SABİT öneki (TEK KAYNAK).
 *
 * email_log'da "mail türü" kolonu YOKTUR (migration eklenmiyor) → tür KONUDAN ayırt edilir.
 * /ops replay'i bu öneki taşıyan satırları teslimat işi olarak yeniden kuyruğa ALMAZ (aksi halde
 * bir durum bildirimini "replay" etmek müşteriye tüm anahtarları gönderirdi).
 * YENİ bir bildirim türü eklenirse öneki NOTICE_SUBJECT_PREFIXES'e EKLENMELİDİR.
 */
export const REPLACEMENT_NOTICE_SUBJECT_PREFIX = 'Değişim talebiniz';

/**
 * Teslimat OLMAYAN (dolayısıyla teslimat işi olarak replay edilemeyecek) mail konularının
 * önekleri. '[TEST MODU] ' sandbox öneki ve '[TEST] ' şablon test maili de dahildir.
 */
export const NOTICE_SUBJECT_PREFIXES = [
  REPLACEMENT_NOTICE_SUBJECT_PREFIX,
  `[TEST MODU] ${REPLACEMENT_NOTICE_SUBJECT_PREFIX}`,
  '[TEST]', // templates.service.sendTest — şablon test maili (orderId zaten null)
] as const;

/**
 * email_log satırının teslimat maili OLUP OLMADIĞINI konudan çıkarır.
 *
 * Neden konu: şema değişmiyor ve email_log'un TÜM üreticileri panelde (enqueueDelivery /
 * enqueueReplacementNotice / templates.sendTest). Teslimat konuları OPERATÖRÜN yazdığı
 * şablondan render edildiği için beyaz-liste kurulamaz; bu yüzden BİLİNEN bildirim önekleri
 * kara-listedir ve tek kaynaktan (NOTICE_SUBJECT_PREFIXES) okunur.
 */
export function isDeliverySubject(subject: string): boolean {
  const s = subject.trimStart();
  return !NOTICE_SUBJECT_PREFIXES.some((p) => s.startsWith(p));
}

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

    await this.queue.add(
      MAIL_DELIVERY_JOB,
      { orderId, emailLogId: log!.id } satisfies DeliveryJob,
      MAIL_JOB_OPTS,
    );
  }

  /**
   * Değişim/garanti talebi DURUM bildirimini KUYRUĞA ALIR (§13).
   *
   * NEDEN KUYRUK (denetim bulgusu): bildirim eskiden DOĞRUDAN SMTP ile, TEK denemede
   * gönderiliyordu → geçici bir SMTP hatası (relay 4xx, ağ kesintisi) bildirimi KALICI
   * olarak kaybediyordu; üstelik hata içeride yutulduğu için çağıran "bildirildi" işaretini
   * YANLIŞ yazıyordu. Artık teslimat maili ile AYNI garanti: BullMQ + attempts/backoff/
   * removeOnFail (MAIL_JOB_OPTS) + başarısızlıkta /ops dead-letter'da görünür.
   *
   * NOT: teslimat işi (MAIL_DELIVERY_JOB) yalnız lisans payload'ı çözüp gönderir — bir
   * "durum bildirimi" o işe konulursa (a) şablon tüm aktif atamaların GERÇEK anahtarını
   * yeniden yollar, (b) sır düz metne dönerdi. Bu yüzden bildirim AYRI iş adıyla
   * (MAIL_NOTICE_JOB) ve SIRSIZ, hazır gövdeyle taşınır.
   *
   * SÖZLEŞME: bu metot ASLA fırlatmaz (admin aksiyonunu — approve/reject/request-info —
   * bozmaz); sonucu `{ queued }` ile döndürür. Çağıran "müşteri bilgilendirildi" bayrağını
   * BU DEĞERDEN türetmelidir (promise'in çözülmesinden değil).
   */
  async enqueueReplacementNotice(
    orderId: string,
    toEmail: string,
    status: ReplacementNoticeStatus,
    note?: string | null,
  ): Promise<NoticeEnqueueResult> {
    // Sipariş no + sandbox için siparişi/siteyi çöz (yoksa yine gönderilir).
    const [order] = await this.db
      .select({ remoteOrderId: orders.remoteOrderId, siteId: orders.siteId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    let sandbox = false;
    let siteName = 'Mağaza';
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
    // Konu öneki TEK KAYNAKTAN: /ops replay'i mail türünü bu önekle ayırt eder
    // (bkz. REPLACEMENT_NOTICE_SUBJECT_PREFIX) — metin burada elle değiştirilmemeli.
    const subject = `${REPLACEMENT_NOTICE_SUBJECT_PREFIX} — ${orderNo}`;
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

    // Sandbox (test modu, §14): gerçek müşteriye GİTMEZ — yöneticiye yönlendirilir. Karar
    // ENQUEUE anında verilir (worker sade kalsın; site sonradan sandbox'tan çıksa bile
    // kuyruktaki iş oluşturulduğu andaki kurala uyar).
    let logId: string | null = null;
    try {
      const mailFrom = this.config.getOrThrow<string>('MAIL_FROM');
      const finalSubject = sandbox ? `[TEST MODU] ${subject}` : subject;
      const finalTo = sandbox ? mailFrom : toEmail;

      // email_log kaydı (durum bildirimi de gönderim izine düşer, §9). to_email MÜŞTERİ
      // adresidir (sandbox'ta bile) — teslimat yoluyla AYNI semantik: log "kime yönelikti"
      // sorusunu yanıtlar, gerçek SMTP alıcısı işin `to` alanındadır.
      const [log] = await this.db
        .insert(emailLog)
        .values({ orderId, toEmail, subject: finalSubject, status: 'queued' })
        .returning({ id: emailLog.id });
      logId = log!.id;

      await this.queue.add(
        MAIL_NOTICE_JOB,
        {
          emailLogId: logId,
          to: finalTo,
          subject: finalSubject,
          body,
        } satisfies ReplacementNoticeJob,
        MAIL_JOB_OPTS,
      );
      return { queued: true, emailLogId: logId };
    } catch (err) {
      // Kuyruğa alınamadı (DB/Redis erişilemez). Admin aksiyonunu BOZMA — dürüstçe raporla.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Değişim bildirimi kuyruğa alınamadı (order=${orderId}): ${message}`);
      if (logId) await this.setStatus(logId, 'failed', message).catch(() => undefined);
      return { queued: false, emailLogId: logId, error: message };
    }
  }

  /**
   * MAIL_NOTICE_JOB işinin GERÇEK gönderimi — BullMQ worker'ı (MailProcessor) çağırır.
   *
   * Teslimat işinden farkı: hiçbir şey ÇÖZMEZ (payload/atama okumaz) → sır sızma yüzeyi yok.
   * Idempotent: email_log zaten 'sent' ise tekrar göndermez (retry'da mükerrer mail olmaz).
   * Hata durumunda email_log 'failed' yazılır ve hata YENİDEN FIRLATILIR → BullMQ tekrar dener
   * (attempts tükenirse iş dead-letter'da, kayıt /ops listesinde görünür).
   */
  async sendNoticeJob(data: ReplacementNoticeJob): Promise<void> {
    const [existing] = await this.db
      .select({ status: emailLog.status })
      .from(emailLog)
      .where(eq(emailLog.id, data.emailLogId))
      .limit(1);
    if (existing?.status === 'sent') return;

    try {
      const mailFrom = this.config.getOrThrow<string>('MAIL_FROM');
      const info = await this.mailer().sendMail({
        from: mailFrom,
        to: data.to,
        subject: data.subject,
        text: data.body,
      });
      /*
       * Mail GİTTİ: log güncellemesi patlasa bile işi FAIL etme (retry = mükerrer mail).
       *
       * SESSİZ DEĞİL (denetim C6, MailProcessor ile AYNI desen): yazım düşerse kayıt sonsuza
       * dek 'queued' kalır → yukarıdaki idempotency kapısı bir daha AÇILMAZ ve iş yeniden
       * koşarsa müşteriye İKİNCİ bildirim maili gider; ayrıca satır /ops'ta 'askıda' görünür.
       * Tek sınırlı yeniden deneme: arızaların çoğu anlık bağlantı kesintisidir.
       */
      try {
        await this.setStatus(data.emailLogId, 'sent', null, info.messageId);
      } catch (first) {
        this.logger.warn(
          `email_log 'sent' yazımı başarısız, bir kez daha denenecek (emailLog=${data.emailLogId}): ${String(first)}`,
        );
        try {
          await this.setStatus(data.emailLogId, 'sent', null, info.messageId);
        } catch (err) {
          this.logger.error(
            `Bildirim maili GÖNDERİLDİ ama email_log 'sent' yazılamadı (emailLog=${data.emailLogId}) — ` +
              `kayıt 'queued' kaldı, olası MÜKERRER bildirim riski: ${
                err instanceof Error ? err.message : String(err)
              }`,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.setStatus(data.emailLogId, 'failed', message).catch(() => undefined);
      throw err; // BullMQ yeniden denesin
    }
  }

  private replacementHeadline(status: ReplacementNoticeStatus): string {
    switch (status) {
      case 'approved':
        return 'Değişim talebiniz onaylandı, yeni lisansınız hazır.';
      case 'rejected':
        return 'Talebiniz incelendi ve bu kez onaylanmadı.';
      case 'info_requested':
        return 'Talebinizi değerlendirebilmemiz için ek bilgiye ihtiyacımız var.';
      default:
        return 'Talebinizin durumu güncellendi.';
    }
  }

  private mailer(): Transporter {
    // Ortak kurucu: teslimat maili (MailProcessor) ile AYNI auth/TLS yapılandırması →
    // kimlik-doğrulamalı relay'de değişim bildirimleri artık sessizce 'failed' olmaz.
    if (!this.transporter) {
      this.transporter = createMailTransport(this.config);
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
