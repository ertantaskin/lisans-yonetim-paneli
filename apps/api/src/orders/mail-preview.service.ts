import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { auditLog, orders } from '../db/schema';
import { DeliveryMailBuilder } from '../mail/delivery-mail.builder';

/** Önizleme yanıtı — üretilemeyen durum da 200 döner (sebebi okunur bir cümledir). */
export interface DeliveryMailPreview {
  /** Gövde üretilebildi mi? false ise yalnız `message` anlamlıdır. */
  available: boolean;
  /** Operatöre gösterilecek açıklama (available=false ise SEBEP; true ise sınır notu). */
  message: string;
  /** Nihai konu (sandbox'ta '[TEST MODU] ' öneki dahil). */
  subject: string | null;
  /**
   * Nihai SMTP gönderici başlığı (`MAIL_FROM`) — önizleme ekranındaki "Kimden" satırı.
   * Gerçek gönderimin kullandığı DEĞERİN ta kendisidir (`DeliveryMailContent.from`).
   */
  from: string | null;
  /** Nihai SMTP alıcısı (sandbox'ta yönetici adresi). */
  to: string | null;
  /** Siparişin müşteri adresi. */
  customerEmail: string | null;
  /** Düz metin gövde (mail `text/plain` gider — panel bunu HTML olarak YORUMLAMAZ). */
  text: string | null;
  /** Site test modunda mı (§14): mail müşteriye gitmez, yöneticiye yönlenir. */
  sandbox: boolean;
  /** Sırlar maskeli mi (owner-OLMAYAN admin → true). */
  masked: boolean;
  /** Gövdeye giren lisans kalemi / kurulum rehberi sayısı. */
  itemCount: number;
  guideCount: number;
  /**
   * HER ZAMAN true — bu bir ARŞİV DEĞİL, ANLIK yeniden üretimdir. Alan bilinçli olarak
   * sözleşmede durur: istemci bu gerçeği operatöre yazmak zorundadır (bkz. `message`).
   */
  regenerated: true;
}

/**
 * Sipariş detayındaki "gönderilen maili önizle" (kullanıcı isteği: içeriği yeniden
 * göndermeden teyit edebilmek).
 *
 * ÖNEMLİ MİMARİ GERÇEK: `email_log` mail GÖVDESİNİ SAKLAMAZ — yalnız alıcı/konu/durum/hata
 * tutar (düz metin lisans anahtarı log tablosuna yazılmaz; bilinçli, migration eklenmez).
 * Dolayısıyla burada gösterilen metin "gönderilen kopyanın arşivi" değil, ŞABLONUN SİPARİŞİN
 * GÜNCEL VERİSİYLE yeniden üretilmiş hâlidir. Sipariş o günden beri değiştiyse (değişim,
 * iptal, yeni atama, şablon düzenlemesi) çıktı da farklı olur. Bu sınır `message` ile
 * operatöre AÇIKÇA söylenir — aksi halde ekranı bir arşiv sanar ve yanlış sonuç çıkarır.
 *
 * NEDEN AYRI (KÜÇÜK) SERVİS: gövde üretimi zaten `DeliveryMailBuilder`'da (gerçek gönderim
 * ile TEK kaynak). Burada kalan tek iş rol-farkında maskeleme kararı + reveal denetim kaydı.
 * `AdminOrdersService`'in kurucusuna yeni bir bağımlılık eklemek 30 test çağıranını birden
 * güncellemeyi gerektirirdi (bu projede "yeni ctor arg = tüm çağıranları güncelle" dersi);
 * ayrık bir servis aynı işi sıfır çarpanla yapar.
 */
@Injectable()
export class MailPreviewService {
  private readonly logger = new Logger(MailPreviewService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly builder: DeliveryMailBuilder,
  ) {}

  /**
   * Siparişin teslimat mailini ÜRETİR ve döndürür — GÖNDERMEZ, kuyruğa ALMAZ.
   *
   * @param orderId Sipariş kimliği.
   * @param actor   Denetim kaydına yazılacak operatör (x-admin-actor).
   * @param reveal  `canRevealPlaintext(role)` sonucu. owner (veya auth KAPALI) → düz metin +
   *                `reveal` denetim kaydı; owner-OLMAYAN 'admin' → MASKELİ gövde ve denetim
   *                kaydı YAZILMAZ (maskeli görüntüleme bir "reveal" değildir; yanıltıcı iz üretmez).
   */
  async previewDelivery(
    orderId: string,
    actor: string,
    reveal: boolean,
  ): Promise<DeliveryMailPreview> {
    // Sipariş yoksa 404 (builder da aynı istisnayı atar; burada erken/açık kapı).
    const [order] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const built = await this.builder.build(orderId, { reveal });

    if (!built.ok) {
      return {
        available: false,
        message:
          'Bu sipariş için şu anda gönderilecek bir teslimat maili üretilemiyor: siparişte aktif ' +
          'lisans ataması yok (henüz teslim edilmemiş olabilir; ya da tüm lisanslar iade/iptal ' +
          'edilmiş veya süresi dolup gizlenmiş olabilir).',
        subject: null,
        from: null,
        to: null,
        customerEmail: null,
        text: null,
        sandbox: false,
        masked: !reveal,
        itemCount: 0,
        guideCount: 0,
        regenerated: true,
      };
    }

    const c = built.content;

    /*
     * DEĞİŞMEZ KURAL: "reveal/kopyalama audit'e düşer" (§17). Önizleme, sipariş detayıyla AYNI
     * düz metin sırları ekrana basar → aynı iz bırakmalıdır. Maskeli önizlemede (owner-olmayan)
     * gerçek bir sır gösterilmediği için kayıt YAZILMAZ.
     *
     * best-effort: denetim yazımı bu OKUMA yolunu düşürmez, ama SESSİZ de kalmaz (yazım
     * başarısızsa düz metin gösterilmiş olur ve `/audit` "kimse görüntülemedi" der).
     */
    if (reveal) {
      try {
        await this.db.insert(auditLog).values({
          action: 'reveal',
          actor,
          targetType: 'order',
          targetId: orderId,
          /*
           * `auto` BİLEREK YOK. Bu kod tabanında `meta.auto=true` "sayfa açılışında
           * kendiliğinden yazılan gürültü" demektir ve İKİ yerde o anlamla tüketilir:
           * sipariş detayının Denetim İzi kartı bu satırları ELER, saklama süpürmesi de
           * 90 gün sonra SİLER. Mail önizlemesi kendiliğinden değil — operatör göz ikonuna
           * basar ve siparişin TÜM anahtarları/parolaları düz metin ekrana gelir. Yani en
           * kasıtlı düz-metin görüntüleme, tam da denetim izinde görünmesi gereken kayıttır.
           */
          meta: { view: 'mail_preview', count: c.itemCount },
        });
      } catch (err) {
        this.logger.error(
          `REVEAL AUDIT YAZILAMADI — mail önizlemesinde düz metin gösterildi ama denetim izine ` +
            `geçmedi (sipariş=${orderId}, aktör=${actor}): ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
    }

    const notes = [
      'Bu metin ARŞİV DEĞİLDİR: mail gövdesi hiçbir yerde saklanmaz (düz metin lisans log ' +
        'tablosuna yazılmaz), bu yüzden şablon siparişin GÜNCEL verisiyle yeniden üretildi. ' +
        'Sipariş o tarihten sonra değiştiyse gönderilen kopya birebir aynı olmayabilir.',
    ];
    if (c.sandbox) {
      notes.push(
        'Mağaza TEST MODUNDA: bu mail müşteriye değil, yönetici adresine gönderilir ve konusu ' +
          '"[TEST MODU]" ile başlar.',
      );
    }
    if (c.masked) {
      notes.push(
        'Lisans/parola alanları MASKELİDİR (düz metin görüntüleme yalnız sahip hesabındadır) — ' +
          'müşteriye giden mailde bu alanlar açık gider.',
      );
    }

    return {
      available: true,
      message: notes.join(' '),
      subject: c.subject,
      from: c.from,
      to: c.to,
      customerEmail: c.customerEmail,
      text: c.text,
      sandbox: c.sandbox,
      masked: c.masked,
      itemCount: c.itemCount,
      guideCount: c.guideCount,
      regenerated: true,
    };
  }
}
