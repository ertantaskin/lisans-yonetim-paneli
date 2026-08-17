import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import {
  AccountPayloadSchema,
  MASK_PREFIX,
  buildGuideMailBlock,
  maskAccountFields,
  maskSecret,
  parseAccountPayload,
  type ProductGuide,
} from '@lisans/shared';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import {
  assignments,
  licenseItems,
  orderLines,
  orders,
  productGuides,
  products,
  sites,
} from '../db/schema';
import { TemplatesService, render } from './templates.service';
import {
  earliestValidUntil,
  formatValidUntil,
  formatValidUntilIso,
  unitLabel,
  withGuides,
} from './mail-render';

/**
 * Üretilmiş teslimat maili — GERÇEK gönderim ile ÖNİZLEME arasındaki tek sözleşme.
 *
 * `to` NİHAİ SMTP alıcısıdır (sandbox'ta yöneticiye yönlenir); müşterinin adresi ayrıca
 * `customerEmail` alanındadır — önizleme ekranı ikisini de göstererek "test modundaki bir
 * siparişin maili müşteriye gitmiyor" gerçeğini operatörden gizlemez.
 */
export interface DeliveryMailContent {
  /**
   * Nihai SMTP gönderici başlığı (`MAIL_FROM`) — gerçek gönderimde `sendMail({from})` ile
   * BİREBİR aynı değer. Önizleme ekranı zarf başlığını buradan kurar; ayrı bir yerden
   * okunsaydı panelde görünen "Kimden" ile müşterinin gördüğü ayrışabilirdi.
   */
  from: string;
  /** Nihai SMTP alıcısı (sandbox → MAIL_FROM). */
  to: string;
  /** Siparişin müşteri adresi (sandbox'ta bile gerçek adres). */
  customerEmail: string;
  /** Nihai konu (sandbox'ta '[TEST MODU] ' öneki dahil). */
  subject: string;
  /** Nihai düz metin gövde (mail `text/plain` gönderilir — HTML gövde YOK). */
  text: string;
  /** Site test modunda mı (§14): true ise mail müşteriye GİTMEZ. */
  sandbox: boolean;
  /** Maile giren atama (lisans kalemi) sayısı. */
  itemCount: number;
  /** Maile giren kurulum rehberi sayısı (§7). */
  guideCount: number;
  /**
   * Sırlar maskelendi mi? `false` = gövde DÜZ METİN lisans/parola İÇERİR (gerçek gönderim ve
   * owner önizlemesi). Çağıran reveal denetim kaydını BU bayrağa bakarak yazar.
   */
  masked: boolean;
}

/**
 * Gövde üretilemedi — SEBEBİ makine-okunur (çağıran anlamlı bir mesaj üretebilsin; boş ekran
 * ya da ham hata DEĞİL).
 *  - `no-active-assignments`: siparişte maile girecek AKTİF atama yok (henüz teslim edilmemiş,
 *    tamamı iade/iptal edilmiş ya da süresi geçip gizlenmiş).
 */
export type DeliveryMailSkipReason = 'no-active-assignments';

export type DeliveryMailBuild =
  | { ok: true; content: DeliveryMailContent }
  | { ok: false; reason: DeliveryMailSkipReason };

/**
 * Teslimat mailinin TEK render yolu (§6).
 *
 * NEDEN AYRI SINIF: bu gövde iki yerden isteniyor — (a) BullMQ worker gerçekten gönderirken,
 * (b) operatör sipariş detayından "önizle" derken. İkinci bir render yazmak bu projede
 * TEKRARLAYAN bir hata sınıfıdır (mail ile müşteri sayfası bir kez ayrışmıştı: rehber sırası,
 * geçerlilik tarihi biçimi, `{{guides}}` yerleşimi). Şablon çözümü (ürün+site önceliği),
 * değişken doldurma, rehber blokları, sandbox yönlendirmesi ve kalem sırası burada TEK KEZ
 * tanımlıdır; iki çağıran da AYNI çıktıyı alır.
 *
 * TEK FARK `reveal`: önizlemede owner-OLMAYAN admin için sırlar maskelenir (denetim A1).
 * Gerçek gönderim HER ZAMAN `reveal: true` çağırır — müşteri kendi lisansını maskeli alamaz.
 *
 * SAKLANMIŞ GÖVDE YOKTUR: `email_log` yalnız alıcı/konu/durum tutar (düz metin lisans log'a
 * yazılmaz — bilinçli, migration eklenmez). Dolayısıyla önizleme bir ARŞİV değil, ANLIK
 * yeniden üretimdir: sipariş o günden beri değiştiyse (değişim/iptal/yeni atama/şablon
 * düzenlemesi) çıktı da farklı olur. Bu sınırı UI operatöre AÇIKÇA söylemek zorundadır.
 */
@Injectable()
export class DeliveryMailBuilder {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly templates: TemplatesService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Siparişin teslimat mailini üretir — GÖNDERMEZ (saf okuma + render).
   *
   * @param orderId Sipariş kimliği.
   * @param opts.reveal `true` → düz metin sırlar (gerçek gönderim / owner önizlemesi),
   *                    `false` → key maskeli, hesap alanları ALAN-FARKINDA maskeli.
   * @throws NotFoundException sipariş yoksa (gönderim yolunda BullMQ hatası olarak görünür).
   */
  async build(orderId: string, opts: { reveal: boolean }): Promise<DeliveryMailBuild> {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const [site] = await this.db.select().from(sites).where(eq(sites.id, order.siteId)).limit(1);

    /*
     * Maile girecek atamaların KAPSAMI — TEK KAYNAK.
     *
     * Aynı yüklem hem anahtar satırlarını hem rehber sorgusunu süzer; iki yerde ayrı ayrı
     * yazılsaydı biri güncellenip diğeri unutulduğunda mail, teslim edilmeyen (ya da süresi
     * geçmiş) bir ürünün rehberini taşırdı.
     */
    const deliveredScope = and(
      eq(assignments.orderId, orderId),
      eq(assignments.status, 'active'),
      // #7 denetim (yarış savunması) — getDeliveries ile SİMETRİK: iptal/iade edilmiş
      // satırın (canceled) ataması ASLA maile girmez.
      eq(orderLines.canceled, false),
      // Savunma amaçlı süre filtresi (getDeliveries ile birebir aynı invaryant): expiry job
      // gecikse bile onExpiry='hide' ürünün süresi geçmiş payload'ı gövdeye KONULMAZ (düz
      // metin parola sızmaz). 'keep' ürün süre sonrası da teslim edilir.
      or(
        isNull(assignments.validUntil),
        gt(assignments.validUntil, sql`now()`),
        eq(products.onExpiry, 'keep'),
      ),
    );

    /*
     * §7 kurulum rehberleri AYRI sorguda (rows'a bağlı DEĞİL → aynı Promise.all'da paralel,
     * ek round-trip yok). Rehber gövdesi atama satırlarının LEFT JOIN'inde taşınsaydı SATIR
     * BAŞINA tekrarlanırdı (50 anahtarlı siparişte 4.000 karakterlik metin 50 kez). `distinct`
     * şart: aynı rehbere bağlı birden çok satır tekrar üretirdi.
     */
    const [rows, guideRows] = await Promise.all([
      this.db
        .select({
          units: assignments.units,
          validUntil: assignments.validUntil,
          payloadEnc: licenseItems.payloadEnc,
          licenseItemId: licenseItems.id,
          productName: products.name,
          productId: orderLines.productId,
          productKind: products.kind,
          payloadSchema: products.payloadSchema,
          // MAK/çok kullanımlık ayrımı: birim etiketinin ANLAMI buna bağlı (aşağıdaki
          // `unitLabel`). `units` tek başına yeterli DEĞİLDİR — tek kullanımlıkta da 1'dir.
          usageMode: products.usageMode,
        })
        .from(assignments)
        .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
        .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
        .leftJoin(products, eq(orderLines.productId, products.id))
        .where(deliveredScope)
        // SIRA: gövdedeki anahtarlar stoğa giriş sırasında (getDeliveries + admin sipariş
        // detayı ile AYNI yön) — üç yüzey aynı sırayı gösterir.
        .orderBy(licenseItems.seq),

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

    // Aktif atama yoksa (ör. tümü revoke edildikten sonra resend) BOŞ mail üretilmez.
    if (rows.length === 0) return { ok: false, reason: 'no-active-assignments' };

    const itemsBlock = rows
      .map((r) => {
        const plain = this.crypto.decrypt(
          r.payloadEnc,
          CryptoService.licenseItemAad(r.licenseItemId),
        );
        const label = r.productName ?? 'Ürün';
        const qty = unitLabel(r.units, r.usageMode, r.productKind);
        // Geçerlilik bitişi kaleme YAZILIR: çok kalemli siparişte kalemler FARKLI tarihler
        // taşır → tek bir {{valid_until}} değişkeni bunu doğru anlatamaz.
        const until = formatValidUntil(r.validUntil);
        const untilLine = until ? `\n    Geçerlilik bitişi: ${until}` : '';
        // Hesap ürünü: alan-alan render (Kullanıcı adı: x / Parola: y).
        const schema =
          r.productKind === 'account' ? AccountPayloadSchema.safeParse(r.payloadSchema) : null;
        if (schema?.success) {
          // Maske ALAN-FARKINDA (denetim O10): `maskSecret` kanonik JSON'un kuyruğunu — yani
          // parolanın son karakterlerini — bırakırdı. `maskAccountFields` secret alanı
          // KUYRUKSUZ maskeler, secret olmayan (kullanıcı adı) alan okunur kalır.
          const parsed = parseAccountPayload(schema.data, plain);
          const fields = (opts.reveal ? parsed : maskAccountFields(parsed))
            .map((f) => `    ${f.label}: ${f.value}`)
            .join('\n');
          return `• ${label}${qty}:\n${fields}${untilLine}`;
        }
        return `• ${label}${qty}: ${this.maskPayload(plain, r.productKind, opts.reveal)}${untilLine}`;
      })
      .join('\n');

    /*
     * §7 kurulum/etkinleştirme rehberleri — TEKRARSIZ (`selectDistinct` sağlar).
     *
     * SIRA BAŞLIĞA GÖRE — getDeliveries KANONİKTİR ve o da böyle sıralar (`selectDistinct`
     * sıra GARANTİ ETMEZ: Postgres hash-aggregate kullanabilir). Adet/boyut tavanları
     * `buildGuideMailBlock` içinde TEK kaynaktan gelir (e-posta istemcisinin kırpma eşiğinden
     * geriye hesaplanmıştır) ve sınıra takılan rehber SESSİZCE düşürülmez.
     */
    const guideList: ProductGuide[] = guideRows
      .map((g) => ({ id: g.id, title: g.title, body: g.body }))
      .sort((a, b) => a.title.localeCompare(b.title, 'tr'));
    const guideBlock = buildGuideMailBlock(guideList);

    // Şablon: ilk satırın ürününe göre (ürün+site → ürün → site → varsayılan, §6).
    const tpl = await this.templates.resolve(rows[0]!.productId, order.siteId);
    // Siparişteki EN YAKIN bitiş — iki değişkenin (yerel biçim + ISO) AYNI anı anlatması için
    // tek kez hesaplanır (iki ayrı çağrı, aralarında sweep koşarsa ayrışabilirdi).
    const earliest = earliestValidUntil(rows.map((r) => r.validUntil));
    const vars = {
      order_no: order.remoteOrderId,
      site_name: site?.domain ?? 'Mağaza',
      product_name: rows[0]!.productName ?? '',
      units: String(rows.reduce((s, r) => s + r.units, 0)),
      customer_email: order.customerEmail,
      items: itemsBlock,
      // Süreli hesap (§11): siparişteki EN YAKIN tarih (kalem kalem doğru tarih zaten
      // `{{items}}` bloğunda yazılıdır). Süresiz üründe BOŞ string.
      valid_until: formatValidUntil(earliest),
      valid_until_iso: formatValidUntilIso(earliest),
      // §7 rehber bloğu. Rehbersiz siparişte BOŞ string → token sessizce kaybolur.
      guides: guideBlock.text,
    };

    // Sandbox (test modu, §14): site.sandbox=true ise gerçek müşteriye mail GİTMEZ — alıcı
    // yöneticiye (MAIL_FROM) yönlendirilir + konu başına '[TEST MODU] ' eklenir.
    const mailFrom = this.config.getOrThrow<string>('MAIL_FROM');
    const sandbox = site?.sandbox === true;
    const subject = render(tpl.subject, vars);

    return {
      ok: true,
      content: {
        from: mailFrom,
        to: sandbox ? mailFrom : order.customerEmail,
        customerEmail: order.customerEmail,
        subject: sandbox ? `[TEST MODU] ${subject}` : subject,
        text: withGuides(render(tpl.body, vars), tpl.body, guideBlock.text),
        sandbox,
        itemCount: rows.length,
        guideCount: guideList.length,
        masked: !opts.reveal,
      },
    };
  }

  /**
   * Hesap OLMAYAN (key/code/custom) payload maskesi.
   *
   * `maskSecret` (sabit gövde + son 4 hane) YALNIZ bu tipler için güvenlidir: son 4 hane
   * "hangi anahtar" sorusunu yanıtlayan iyi huylu bir tanımlayıcıdır. Şeması ÇÖZÜLEMEYEN bir
   * `account` ürününde ise aynı fonksiyon kanonik JSON'un kuyruğunu = parolanın son
   * karakterlerini sızdırırdı → o dalda KUYRUKSUZ tam maske (fail-safe yön: çözemediğimiz
   * payload'ı "sır değil" saymayız — shared `parseAccountPayload` fallback'iyle aynı ilke).
   */
  private maskPayload(plain: string, kind: string | null, reveal: boolean): string {
    if (reveal) return plain;
    return kind === 'account' ? MASK_PREFIX : maskSecret(plain);
  }
}
