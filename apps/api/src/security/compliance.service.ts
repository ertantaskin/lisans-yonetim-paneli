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
    const original = email.trim();
    const redacted = this.redactedFor(normalized);

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
            reason = replace(replace(reason, ${original}, ${redacted}), ${normalized}, ${redacted}),
            resolution_note = replace(replace(resolution_note, ${original}, ${redacted}), ${normalized}, ${redacted}),
            updated_at = now()
        WHERE lower(customer_email) = ${normalized}
        RETURNING id;
      `);
      const anonymizedReplacements = replRows.length;

      // replacement_messages.body (destek yazışması, §13) da serbest-metin PII taşır: müşteri
      // mesajlarında e-posta/ad geçebilir. Bu müşterinin talep kümesindeki (yukarıda dönen id'ler)
      // mesajların gövdesinde adres geçen yerleri maskele. Kapsam talep-id ile sınırlı (başka
      // müşterinin yazışması etkilenmez). Talep yoksa (boş küme) sorgu HİÇ koşmaz.
      let anonymizedMessages = 0;
      const requestIds = replRows.map((r) => r.id);
      if (requestIds.length > 0) {
        const msgRows = await rawRows<{ id: string }>(tx, sql`
          UPDATE replacement_messages
          SET body = replace(replace(body, ${original}, ${redacted}), ${normalized}, ${redacted})
          WHERE request_id = ANY(${requestIds}::uuid[])
            AND (strpos(body, ${original}) > 0 OR strpos(lower(body), ${normalized}::text) > 0)
          RETURNING id;
        `);
        anonymizedMessages = msgRows.length;
      }

      // email_log.to_email de PII taşır (§9): teslimat mailleri gerçek müşteri e-postasını
      // saklar → anonimleştirmede ATLANIRSA unutulma hakkı eksik kalır (audit bulgusu).
      // to_email maskele + konuda geçen e-postayı best-effort değiştir (email_log gövde kolonu yok).
      const emailRows = await rawRows<{ id: string }>(tx, sql`
        UPDATE email_log
        SET to_email = ${redacted},
            subject = replace(replace(subject, ${original}, ${redacted}), ${normalized}, ${redacted})
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
            detail = replace(replace(detail, ${original}, ${redacted}), ${normalized}, ${redacted})
        WHERE lower(subject) = ${normalized}
           -- strpos + AÇIK cast (LIKE değil): e-postada geçebilen '_' / '%' karakterleri
           -- joker gibi davranıp YANLIŞ satır maskelemesin; ::text belirsiz parametre
           -- tipini (unknown) de kesinleştirir.
           OR strpos(lower(detail), ${normalized}::text) > 0
        RETURNING id;
      `);
      const anonymizedSecurityEvents = securityRows.length;

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
      });
      await tx.execute(sql`
        INSERT INTO audit_log (action, actor, target_type, target_id, meta)
        VALUES ('anonymize', ${actor}, 'customer', ${redacted}, ${auditMeta}::jsonb);
      `);

      this.logger.warn(
        `KVKK anonimleştirme: ${anonymizedOrders} sipariş + ${anonymizedReplacements} değişim + ` +
          `${anonymizedEmails} mail + ${anonymizedSecurityEvents} güvenlik kaydı + ` +
          `${anonymizedMessages} destek mesajı maskelendi (aktör=${actor})`,
      );
      return {
        anonymizedOrders,
        anonymizedReplacements,
        anonymizedEmails,
        anonymizedSecurityEvents,
        anonymizedMessages,
        redactedEmail: redacted,
      };
    });
  }
}
