import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';

export interface AnonymizeResult {
  anonymizedOrders: number;
  anonymizedReplacements: number;
  anonymizedEmails: number;
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

      // replacement_requests.customer_email maskele.
      const replRows = await rawRows<{ id: string }>(tx, sql`
        UPDATE replacement_requests
        SET customer_email = ${redacted}, updated_at = now()
        WHERE lower(customer_email) = ${normalized}
        RETURNING id;
      `);
      const anonymizedReplacements = replRows.length;

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

      // customers profil satırını sil (kalıcı meta — etiket/not — PII taşır).
      await tx.execute(sql`DELETE FROM customers WHERE lower(email) = ${normalized};`);

      // KVKK silme isteği kritik aksiyon → audit'e düş (§9). Ham e-posta LOGLANMAZ; yalnız maske.
      // 'anonymize' değeri audit_action enum'unda mevcut (enums.ts, migration 0010).
      const auditMeta = JSON.stringify({ anonymizedOrders, anonymizedReplacements, anonymizedEmails });
      await tx.execute(sql`
        INSERT INTO audit_log (action, actor, target_type, target_id, meta)
        VALUES ('anonymize', ${actor}, 'customer', ${redacted}, ${auditMeta}::jsonb);
      `);

      this.logger.warn(
        `KVKK anonimleştirme: ${anonymizedOrders} sipariş + ${anonymizedReplacements} değişim + ` +
          `${anonymizedEmails} mail kaydı maskelendi (aktör=${actor})`,
      );
      return { anonymizedOrders, anonymizedReplacements, anonymizedEmails, redactedEmail: redacted };
    });
  }
}
