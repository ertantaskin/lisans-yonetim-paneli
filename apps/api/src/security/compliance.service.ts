import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';

export interface AnonymizeResult {
  anonymizedOrders: number;
  anonymizedReplacements: number;
  anonymizedEmails: number;
  /**
   * Maskelenen güvenlik olayı (security_events) sayısı. Suistimal/anomali kayıtları
   * `subject` kolonunda MÜŞTERİ E-POSTASI tutar (replacements.recordAbuseEvent) → KVKK
   * kapsamında maskelenmeleri ŞART. Rapor bu yüzden ayrı sayaç döndürür (dürüst rapor:
   * "PII maskelendi" derken hangi kümelerin maskelendiği görünür olsun).
   */
  anonymizedSecurityEvents: number;
  /**
   * Maskelenen destek yazışması (replacement_messages) mesaj sayısı (denetim M3). Müşteri
   * mesaj gövdesi serbest-metin PII (e-posta/ad) taşıyabilir → "unutulma hakkı" kapsamında maskelenir.
   */
  anonymizedMessages: number;
  /**
   * Maskelenen kayıtlı görünüm (saved_views) sayısı (denetim D5/KVKK). `query` operatörün
   * ADRES ÇUBUĞUNU birebir sakladığı için müşteri e-postası taşıyabilir (/customers araması
   * tasarımca e-posta ile yapılır) → "unutulma hakkı" bu kasayı da kapsamalı.
   */
  anonymizedSavedViews: number;
  redactedEmail: string;
}

/**
 * KVKK/GDPR anonimleştirme (§9). "Unutulma hakkı" için müşterinin PII'sini (e-posta)
 * tüm siparişlerden ve değişim taleplerinden geri döndürülemez şekilde maskeler; customers
 * profil satırını siler. Sipariş/atama BÜTÜNLÜĞÜ korunur — kayıt SİLİNMEZ, yalnız PII
 * maskelenir (finansal/operasyonel iz ve mutabakat bozulmaz). Tek yönlü işlem (GET yok).
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  /** E-postadan deterministik kısa maske üretir (aynı kişi = aynı maske → satır ilişkisi izlenebilir kalır). */
  private redactedFor(email: string): string {
    const hash = createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 12);
    return `anon-${hash}@redacted.invalid`;
  }

  /**
   * Verilen e-postaya ait tüm PII'yi maskeler ve customers satırını siler. Idempotent:
   * zaten maskelenmiş e-posta tekrar çağrılırsa 0 satır etkiler. Transaction içinde atomik.
   * @param email Anonimleştirilecek müşteri e-postası
   * @param actor Audit için aktör (ör. 'panel:admin')
   */
  async anonymize(email: string, actor: string): Promise<AnonymizeResult> {
    const normalized = email.trim().toLowerCase();
    const redacted = this.redactedFor(normalized);
    // (Denetim M3 — sweep) Serbest-metin PII maskesi BÜYÜK-KÜÇÜK harf DUYARSIZ olmalı: e-posta
    // yerel/alan kısmı pratikte case-insensitive'dir; müşteri mesajı "Ali@GMAIL.COM" yazmışsa da
    // temizlenmeli. Eski `replace(replace(x, original, ..), normalized, ..)` yalnız iki kasayı
    // yakalıyordu → WHERE (lower/strpos) satırı seçip sayaç artarken üçüncü kasada PII gövdede
    // KALIYORDU (audit "maskelendi" der ama kalır). regexp_replace(...,'gi') tüm kasaları kapatır.
    // Regex meta-karakterleri (. + vb.) JS'te kaçırılır; 'i' bayrağı `original`ı da gereksiz kılar.
    // redacted düz-metindir ('\'/'&'/backref içermez) → değiştirme dizesi güvenli.
    const emailRe = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    /**
     * (Denetim D5) saved_views.query için AYRI desen: orada e-posta URL-KODLU durur.
     * `URLSearchParams.toString()` '@'yi '%40', '+'yı '%2B' yapar → düz `emailRe` bu kasayı
     * KAÇIRIR. Üç varyantı alternasyonla kapsıyoruz: ham · yalnız '@' kodlanmış · tam
     * `encodeURIComponent`. '%' regex meta-karakteri DEĞİL, ek kaçış gerekmez.
     * DÜRÜSTLÜK: bu best-effort'tur — egzotik yüzde-kodlaması (ör. büyük harfli olmayan
     * kodlama, form-urlencoded '*'/'(' varyantları) kapsanmaz; kalan risk operatörün kendi
     * kaydettiği bir süzgeç dizesidir, müşteriye giden bir yüzey değildir.
     */
    const savedViewVariants = [
      normalized,
      normalized.replace(/@/g, '%40'),
      encodeURIComponent(normalized),
    ];
    const savedViewRe = [...new Set(savedViewVariants)]
      .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');

    return this.db.transaction(async (tx) => {
      // orders.customer_email maskele (lowercase eşleştir; zaten maskeliyse etkilenmez).
      const orderRows = await rawRows<{ id: string }>(tx, sql`
        UPDATE orders
        SET customer_email = ${redacted}, updated_at = now()
        WHERE lower(customer_email) = ${normalized}
        RETURNING id;
      `);
      const anonymizedOrders = orderRows.length;

      // replacement_requests.customer_email maskele. AYRICA serbest-metin PII (denetim M3):
      //   · reason — müşterinin KENDİ yazdığı açıklama (adını/e-postasını cümle içinde taşıyabilir),
      //   · resolution_note — admin notu (müşteriye atıfta bulunabilir).
      // email_log.subject / security_events.detail deseniyle best-effort replace: adres geçtiği yerde
      // maskeyle değişir (operasyonel/audit bağlamı korunur, doğrudan tanımlayıcı silinir = KVKK
      // pseudonimizasyon). RETURNING id → mesaj gövdelerini AYNI talep kümesine kapsamak için.
      const replRows = await rawRows<{ id: string }>(tx, sql`
        UPDATE replacement_requests
        SET customer_email = ${redacted},
            reason = regexp_replace(reason, ${emailRe}, ${redacted}, 'gi'),
            resolution_note = regexp_replace(resolution_note, ${emailRe}, ${redacted}, 'gi'),
            updated_at = now()
        WHERE lower(customer_email) = ${normalized}
        RETURNING id;
      `);
      const anonymizedReplacements = replRows.length;

      // replacement_messages.body (destek yazışması, §13) da serbest-metin PII taşır: müşteri
      // mesajlarında e-posta/ad geçebilir. Kapsam bu müşterinin TALEPLERİ ile sınırlı: m.request_id
      // → replacement_requests JOIN'i, YUKARIDA maskelenmiş (customer_email = redacted) taleplere
      // bağlanır (başka müşterinin yazışması etkilenmez). ANY(array) DEĞİL JOIN: drizzle `sql` şablonu
      // JS dizisini virgülle ayırdığı için `ANY(${arr}::uuid[])` bozuk SQL üretir ("malformed array
      // literal"). strpos filtresi: yalnız gerçekten adres geçen mesajı say (idempotent: 2. çağrıda
      // gövde zaten temiz → 0). replRows.id KULLANILMAZ (JOIN yeterli).
      const msgRows = await rawRows<{ id: string }>(tx, sql`
        UPDATE replacement_messages m
        SET body = regexp_replace(m.body, ${emailRe}, ${redacted}, 'gi')
        FROM replacement_requests r
        WHERE m.request_id = r.id
          AND r.customer_email = ${redacted}
          AND strpos(lower(m.body), ${normalized}::text) > 0
        RETURNING m.id;
      `);
      const anonymizedMessages = msgRows.length;

      // email_log.to_email de PII taşır (§9): teslimat mailleri gerçek müşteri e-postasını
      // saklar → anonimleştirmede ATLANIRSA unutulma hakkı eksik kalır (audit bulgusu).
      // to_email maskele + konuda geçen e-postayı best-effort değiştir (email_log gövde kolonu yok).
      const emailRows = await rawRows<{ id: string }>(tx, sql`
        UPDATE email_log
        SET to_email = ${redacted},
            subject = regexp_replace(subject, ${emailRe}, ${redacted}, 'gi')
        WHERE lower(to_email) = ${normalized}
        RETURNING id;
      `);
      const anonymizedEmails = emailRows.length;

      // security_events de PII taşır (§9/§15) — suistimal/anomali kayıtlarında `subject`
      // MÜŞTERİ E-POSTASIDIR (replacements.recordAbuseEvent) ve /security ekranında düz
      // gösterilir. ATLANIRSA anonymize "PII maskelendi" der ama e-posta panelde durmaya
      // devam eder (denetim bulgusu). subject TAM eşleşmede maskelenir; `detail` serbest
      // metninde geçen adres de best-effort değiştirilir (bazı kayıtlar adresi cümle içinde
      // taşıyabilir). Eşleşme e-posta kolonlarıyla AYNI kuralla: lower() normalize.
      //
      // KAPSAM NOTU (bilinçli): `meta` jsonb'ye DOKUNULMAZ — mevcut yazarların meta'sı yalnız
      // sayaç/eşik/scope taşır (PII yok). Yeni bir yazar meta'ya PII koyarsa burası da
      // güncellenmeli (jsonb metin değişimi tip güvenliğini bozabileceğinden şimdi eklenmedi).
      const securityRows = await rawRows<{ id: string }>(tx, sql`
        UPDATE security_events
        SET subject = CASE WHEN lower(subject) = ${normalized} THEN ${redacted} ELSE subject END,
            detail = regexp_replace(detail, ${emailRe}, ${redacted}, 'gi')
        WHERE lower(subject) = ${normalized}
           -- strpos + AÇIK cast (LIKE değil): e-postada geçebilen '_' / '%' karakterleri
           -- joker gibi davranıp YANLIŞ satır maskelemesin; ::text belirsiz parametre
           -- tipini (unknown) de kesinleştirir.
           OR strpos(lower(detail), ${normalized}::text) > 0
        RETURNING id;
      `);
      const anonymizedSecurityEvents = securityRows.length;

      /**
       * saved_views.query (denetim D5 / KVKK) — "kayıtlı görünüm" operatörün ADRES ÇUBUĞUNU
       * BİREBİR saklar (`apps/admin/components/saved-views-menu.tsx`: `?${searchParams}`) ve
       * menü /customers + /quarantine/records ekranlarına bağlıdır. /customers araması
       * TASARIMCA e-posta ile yapılır (`?q=musteri@ornek.test`) → müşteri PII'si bu kasada
       * KALICI olarak durur ve anonymize onu HİÇ görmüyordu ("PII maskelendi" raporu eksik
       * kalıyordu).
       *
       * KAPSAM (dürüstlük): TAM lisans anahtarı bu yolla sızmaz — envanter araması React
       * state'inde yaşar, adrese yazılmaz. Maskelenen şey e-posta PII'sidir.
       *
       * `name` (operatörün verdiği görünen ad) KAPSAM DIŞI: serbest metindir ama operatörün
       * kendi etiketidir; e-posta yapıştırılmışsa aynı desen orada da çalışırdı — bilinçli
       * olarak dokunulmuyor ki görünüm adları (operasyonel kimlik) bozulmasın.
       *
       * WHERE ~* : yalnız gerçekten adres geçen satır sayılır → idempotent (2. çağrıda 0).
       * Maske düz metindir; query içine kodlanmadan yazılır (round-trip sadakati DEĞİL,
       * PII imhası hedeflenir — görünüm yeniden yüklenirse yalnız "sonuç yok" verir).
       */
      const savedViewRows = await rawRows<{ id: string }>(tx, sql`
        UPDATE saved_views
        SET query = regexp_replace(query, ${savedViewRe}, ${redacted}, 'gi')
        -- ::text AÇIK cast: belirsiz parametre tipi (unknown) '~*' çözümünü şaşırtmasın
        -- (security_events'teki strpos cast'iyle aynı gerekçe).
        WHERE query ~* ${savedViewRe}::text
        RETURNING id;
      `);
      const anonymizedSavedViews = savedViewRows.length;

      // customers profil satırını sil (kalıcı meta — etiket/not — PII taşır).
      await tx.execute(sql`DELETE FROM customers WHERE lower(email) = ${normalized};`);

      // KVKK silme isteği kritik aksiyon → audit'e düş (§9). Ham e-posta LOGLANMAZ; yalnız maske.
      // 'anonymize' değeri audit_action enum'unda mevcut (enums.ts, migration 0010).
      const auditMeta = JSON.stringify({
        anonymizedOrders,
        anonymizedReplacements,
        anonymizedEmails,
        anonymizedSecurityEvents,
        anonymizedMessages,
        anonymizedSavedViews,
      });
      await tx.execute(sql`
        INSERT INTO audit_log (action, actor, target_type, target_id, meta)
        VALUES ('anonymize', ${actor}, 'customer', ${redacted}, ${auditMeta}::jsonb);
      `);

      this.logger.warn(
        `KVKK anonimleştirme: ${anonymizedOrders} sipariş + ${anonymizedReplacements} değişim + ` +
          `${anonymizedEmails} mail + ${anonymizedSecurityEvents} güvenlik kaydı + ` +
          `${anonymizedMessages} destek mesajı + ${anonymizedSavedViews} kayıtlı görünüm ` +
          `maskelendi (aktör=${actor})`,
      );
      return {
        anonymizedOrders,
        anonymizedReplacements,
        anonymizedEmails,
        anonymizedSecurityEvents,
        anonymizedMessages,
        anonymizedSavedViews,
        redactedEmail: redacted,
      };
    });
  }
}
