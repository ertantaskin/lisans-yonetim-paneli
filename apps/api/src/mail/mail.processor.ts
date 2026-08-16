import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { type Transporter } from 'nodemailer';
import {
  AccountPayloadSchema,
  buildGuideMailBlock,
  parseAccountPayload,
  type ProductGuide,
} from '@lisans/shared';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import {
  assignments,
  emailLog,
  licenseItems,
  orderLines,
  orders,
  productGuides,
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
 * Yerel saat dilimi etiketi (ör. `UTC+03:00`) — o ANDAKİ ofset (yaz saati dahil doğru).
 *
 * ICU'ya (`timeZoneName`) BİLEREK dayanmaz: çıktı Node/ICU sürümüne göre "GMT+3" / "+3" gibi
 * değişebilirdi ve bu değer hem maile hem şablon önizlemesine giriyor — iki yüzeyin ayrışmaması
 * için biçim deterministik olmalı.
 */
function localUtcOffsetLabel(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

/**
 * Geçerlilik bitişini müşteriye gösterilecek YEREL tarih-SAATE çevirir (§11 süreli hesap).
 *
 * NEDEN SAAT ve SAAT DİLİMİ VAR (ölçülmüş sapma): burası yalnız GÜN yazıyordu ve gün, API
 * konteynerinin saat dilimine göre hesaplanıyordu; müşteri sayfası/.txt ise MAĞAZANIN saat
 * diliminde ve SAATLİ gösteriyordu. İkisini bağlayan hiçbir kod yoktu. Somut sonuç:
 * `valid_until = 2026-08-16T22:30Z` + mağaza UTC ise mail "17.08.2026", sayfa "16.08.2026 22:30"
 * diyordu — süreli hesap müşterisi bir günü olduğunu (ya da olmadığını) sanıyordu. Belirsizlik
 * en kötü seçenektir: hangi dilimde gösterildiği artık METİNDE yazılıdır ve makine-okunur
 * karşılığı `{{valid_until_iso}}` ile ayrıca sunulur.
 *
 * Boş/geçersiz değer → '' (şablon token'ı boş kalır, mail bozulmaz — kritik olmayan bir alan
 * yüzünden teslimat maili ASLA düşmemeli). Saat dilimi konteynerden gelir (docker-compose:
 * TZ=Europe/Istanbul) → panelin gösterdiği gün sınırıyla aynı.
 */
export function formatValidUntil(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  // Saat ELLE biçimlenir: `toLocaleTimeString` bazı ICU sürümlerinde gece yarısını '24:00'
  // yazar ve hour12/hourCycle davranışı sürüme göre değişir — tarih zaten kritik bir alan.
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date} ${time} (${localUtcOffsetLabel(d)})`;
}

/**
 * Aynı değerin HAM ISO 8601 (UTC) karşılığı — `{{valid_until_iso}}`.
 *
 * Yerel biçim insan içindir ve saat dilimi etiketiyle birlikte okunmalıdır; ISO ise
 * yoruma kapalıdır. Mağazanın kendi yüzeyi (sayfa/.txt) tarihi zaten UTC anlık değerinden
 * üretir → operatör şablonunda ikisini yan yana kullanarak iki yüzeyi birebir eşleyebilir.
 */
export function formatValidUntilIso(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

/** Şablon gövdesinde `{{guides}}` token'ı geçiyor mu (boşluklu yazım da sayılır). */
const GUIDES_TOKEN_RE = /\{\{\s*guides\s*\}\}/;

/**
 * Rehber bloğunu maile YERLEŞTİRİR — şablonda `{{guides}}` yoksa SONA EKLER.
 *
 * NEDEN FALLBACK VAR (sessiz kayıp koruması): rehber özelliği eklendiğinde operatörlerin
 * veritabanında ZATEN kayıtlı şablonları vardır ve hiçbiri bu token'ı içermez. Yalnız
 * token'a güvenilseydi, panelde rehber tanımlayan operatör onun maile girdiğini SANIR ama
 * müşteri hiçbir zaman göremezdi — üstelik hata da alınmazdı. (Şablon editörü ayrıca
 * "desteklenen değişken" listesini gösterir; token'ı bilerek yerleştirmek isteyen operatör
 * konumu kendisi seçebilir, o durumda bu ek çalışmaz.)
 *
 * @param rendered Token'ları değiştirilmiş nihai gövde.
 * @param template Ham şablon (token aranan yer — render sonrası metinde token kalmaz).
 * @param guides   Rehber bloğu; boşsa hiçbir şey eklenmez.
 */
export function withGuides(rendered: string, template: string, guides: string): string {
  if (!guides) return rendered;
  if (GUIDES_TOKEN_RE.test(template)) return rendered;
  return `${rendered.replace(/\s+$/, '')}\n\n${guides}\n`;
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

      /*
       * Maile girecek atamaların KAPSAMI — TEK KAYNAK.
       *
       * Aynı yüklem hem anahtar satırlarını hem rehber sorgusunu süzer; iki yerde ayrı ayrı
       * yazılsaydı biri güncellenip diğeri unutulduğunda mail, teslim edilmeyen (ya da
       * süresi geçmiş) bir ürünün rehberini taşırdı.
       */
      const deliveredScope = and(
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
      );

      /*
       * §7 kurulum rehberleri AYRI sorguda (rows'a bağlı DEĞİL → aynı Promise.all'da paralel,
       * ek round-trip yok). getDeliveries'te de bu desen kullanılır ve gerekçesi aynıdır:
       * rehber gövdesi atama satırlarının LEFT JOIN'inde taşınırsa SATIR BAŞINA tekrarlanır
       * (50 anahtarlı siparişte 4.000 karakterlik metin 50 kez DB'den taşınır). `distinct`
       * şart: aynı rehbere bağlı birden çok satır (çok kalemli sipariş) tekrar üretirdi.
       */
      const [rows, guideRows] = await Promise.all([
        this.db
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
          .where(deliveredScope)
          // SIRA: mail gövdesindeki anahtarlar da stoğa giriş sırasında (getDeliveries ile
          // AYNI yön). ORDER BY yoktu → müşteriye giden mailde sıra rastgeleydi ve panelde
          // görünen sırayla tutmuyordu.
          .orderBy(licenseItems.seq),
        /*
         * §7 kurulum rehberi — anahtarla BİRLİKTE gitmeli. Müşteri "Office 365'e nasıl
         * giriş yaparım" cevabını mailde bulamazsa destek talebi açıyor.
         *
         * Kapsam yukarıdaki `deliveredScope` ile AYNI: yalnız bu maile GİREN ürünlerin
         * rehberi gider (henüz teslim edilmemiş kalemin rehberi mailde yer almaz — kısmi
         * teslimat bu panelde birinci sınıf akıştır). `products` INNER: rehber bir ürüne
         * bağlıdır, ürünsüz satırın rehberi de olamaz.
         */
        this.db
          .selectDistinct({
            id: productGuides.id,
            title: productGuides.title,
            body: productGuides.body,
          })
          .from(assignments)
          .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
          .innerJoin(products, eq(orderLines.productId, products.id))
          .innerJoin(productGuides, eq(products.guideId, productGuides.id))
          .where(deliveredScope),
      ]);

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

      /*
       * §7 kurulum/etkinleştirme rehberleri — TEKRARSIZ (`selectDistinct` sağlar; uygulama
       * tarafındaki elle tekilleştirme artık gereksiz).
       *
       * SIRA BAŞLIĞA GÖRE — getDeliveries KANONİKTİR ve o da böyle sıralar. Burada sıra
       * satırların sırasından (licenseItems.seq) türetiliyordu: çok rehberli siparişte mail
       * ile müşteri sayfası FARKLI sıra gösteriyordu (aynı bilgi iki yüzeyde ayrışıyordu —
       * bu projede tekrarlayan hata sınıfı). Ayrıca `selectDistinct` sıra GARANTİ ETMEZ
       * (Postgres hash-aggregate kullanabilir) → açık sıralama zaten şarttır.
       *
       * Adet/boyut tavanları `buildGuideMailBlock` içinde ve TEK kaynaktan gelir
       * (packages/shared): sayılar e-posta istemcisinin kırpma eşiğinden geriye doğru
       * hesaplanmıştır ve sınıra takılan rehber SESSİZCE düşürülmez.
       */
      const guideList: ProductGuide[] = guideRows
        .map((g) => ({ id: g.id, title: g.title, body: g.body }))
        .sort((a, b) => a.title.localeCompare(b.title, 'tr'));
      const guideBlock = buildGuideMailBlock(guideList);

      // Şablon: ilk satırın ürününe göre (site override > ürün > varsayılan, §6).
      const tpl = await this.templates.resolve(rows[0]!.productId, order.siteId);
      // Siparişteki EN YAKIN bitiş — iki değişkenin (yerel biçim + ISO) AYNI anı anlatması
      // için tek kez hesaplanır (iki ayrı çağrı, aralarında sweep koşarsa ayrışabilirdi).
      const earliest = earliestValidUntil(rows.map((r) => r.validUntil));
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
        valid_until: formatValidUntil(earliest),
        // Aynı anın yoruma kapalı ISO karşılığı: yerel biçim ile mağaza sayfasının gösterdiği
        // tarih FARKLI GÜN olabildiği için (bkz. formatValidUntil gerekçesi) makine-okunur
        // değer de sunulur — operatör şablonda ikisini eşleyebilir.
        valid_until_iso: formatValidUntilIso(earliest),
        // §7 kurulum/etkinleştirme rehberi bloğu. Rehbersiz siparişte BOŞ string → token
        // sessizce kaybolur (mevcut render davranışı), mailde boşluk bırakmaz.
        guides: guideBlock.text,
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
        text: withGuides(render(tpl.body, vars), tpl.body, guideBlock.text),
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
