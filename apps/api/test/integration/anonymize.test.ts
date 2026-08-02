import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComplianceService } from '../../src/security/compliance.service';
import * as schema from '../../src/db/schema';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  makeCrypto,
  makeDb,
  type Db,
} from './_helpers';

/**
 * KVKK/GDPR anonimleştirme entegrasyon testi (§9) — apps/api/src/security/compliance.service.ts.
 *
 * REGRESYON [AUDIT FIX]: email_log.to_email eskiden anonimleştirmede ATLANIYORDU. Bir müşteri
 * e-postasıyla order + replacement_request + email_log + customers seed edip anonymize çağırır;
 * orders.customer_email, replacement_requests.customer_email VE email_log.to_email hepsinin
 * maskelendiğini, customers satırının silindiğini ve işlemin idempotent olduğunu doğrular.
 */

const tag = randomUUID().slice(0, 8);
const actor = `panel:test-${tag}`;
// Her koşuya özel benzersiz müşteri e-postası (izolasyon). Karışık kasa → normalize yolu da test edilir.
const email = `KVKK-${tag}@Example.Test`;
const normalized = email.trim().toLowerCase();

let db: Db;
let end: () => Promise<void>;
let service: ComplianceService;
let redacted: string;

describe('KVKK anonimleştirme (ComplianceService.anonymize)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    const crypto = makeCrypto();
    // Constructor yalnız db bekler (@Inject(DB)); elle new'liyoruz (Nest DI yok).
    service = new ComplianceService(db as never);

    const site = await createSite(db, crypto, { tag });
    const product = await createProduct(db, { tag });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
      customerEmail: email,
    });

    // replacement_requests — site + order zorunlu; reason notNull. (Denetim M3) reason +
    // resolution_note SERBEST METİN PII: içine e-postayı da geçir → maskeleme yolunu test et.
    const [repl] = await db
      .insert(schema.replacementRequests)
      .values({
        siteId: site.id,
        orderId: order.orderId,
        lineId: order.lineId,
        customerEmail: email,
        reason: `IT test talebi ${tag} — iletişim: ${email}`,
        // (Denetim M3 — sweep) ÜÇÜNCÜ KASA: eski replace(original/normalized) bunu YAKALAYAMAZDI
        // (regexp_replace 'gi' yakalar) — büyük-küçük harf duyarsızlığını kanıtlar.
        resolutionNote: `Çözüldü; müşteri ${email.toUpperCase()} bilgilendirildi.`,
      })
      .returning({ id: schema.replacementRequests.id });

    // (Denetim M3) replacement_messages.body — destek yazışması serbest metni; e-posta İÇERİR
    // (ÜÇÜNCÜ KASA → case-insensitive maske kanıtı).
    await db.insert(schema.replacementMessages).values({
      requestId: repl!.id,
      authorType: 'customer',
      authorName: 'Müşteri',
      body: `Merhaba, siparişimle ilgili sorun var. Bana ${email.toUpperCase()} adresinden dönün.`,
    });

    // email_log — to_email PII (§9). Konuda da e-posta geçir (subject replace yolunu test et).
    await db.insert(schema.emailLog).values({
      orderId: order.orderId,
      toEmail: email,
      subject: `Teslimat: ${email}`,
      status: 'sent',
    });

    // customers profil satırı (lowercase+trim ile yazılır — servis lower() ile eşler).
    await db.insert(schema.customers).values({ email: normalized, notes: `IT ${tag}` });
  });

  afterAll(async () => {
    // email_log ve customers/audit_log cleanupByTag kapsamı dışında — elle sil.
    // (email_log.order_id ON DELETE SET NULL → order silinse de satır kalır.)
    await db.execute(sql`
      DELETE FROM email_log WHERE lower(to_email) IN (${normalized}, ${redacted ?? normalized})
    `);
    await db.execute(sql`
      DELETE FROM customers WHERE lower(email) IN (${normalized}, ${redacted ?? normalized})
    `);
    await db.execute(sql`DELETE FROM audit_log WHERE actor = ${actor}`);
    await cleanupByTag(db, tag);
    await end();
  });

  it('order + replacement + email_log to_email maskelenir; customers silinir; audit düşer', async () => {
    const result = await service.anonymize(email, actor);

    // Maske biçimi: anon-<12hex>@redacted.invalid; ham e-posta sızmaz.
    redacted = result.redactedEmail;
    expect(redacted).toMatch(/^anon-[0-9a-f]{12}@redacted\.invalid$/);

    // En az bir satır etkilendi (seed'lediklerimiz).
    expect(result.anonymizedOrders).toBeGreaterThanOrEqual(1);
    expect(result.anonymizedReplacements).toBeGreaterThanOrEqual(1);
    expect(result.anonymizedEmails).toBeGreaterThanOrEqual(1);

    // orders.customer_email maskelendi — ham e-posta kalmadı.
    const orderRows = await db.execute<{ customer_email: string }>(sql`
      SELECT customer_email FROM orders WHERE lower(customer_email) = ${normalized}
    `);
    expect((orderRows as unknown as unknown[]).length).toBe(0);

    // replacement_requests.customer_email maskelendi.
    const replRows = await db.execute<{ customer_email: string }>(sql`
      SELECT customer_email FROM replacement_requests WHERE lower(customer_email) = ${normalized}
    `);
    expect((replRows as unknown as unknown[]).length).toBe(0);

    // (Denetim M3) replacement_requests.reason + resolution_note serbest metninde ham e-posta KALMADI.
    const replText = await db.execute<{ reason: string; resolution_note: string | null }>(sql`
      SELECT reason, resolution_note FROM replacement_requests WHERE lower(customer_email) = ${redacted}
    `);
    const replTextList = replText as unknown as Array<{ reason: string; resolution_note: string | null }>;
    expect(replTextList.length).toBeGreaterThanOrEqual(1);
    const upper = email.toUpperCase();
    for (const row of replTextList) {
      expect(row.reason).not.toContain(email);
      expect(row.reason).not.toContain(normalized);
      // (Denetim M3 — sweep) case-insensitive: ÜÇÜNCÜ KASA (upper) de temizlenmeli.
      expect(row.resolution_note ?? '').not.toContain(email);
      expect(row.resolution_note ?? '').not.toContain(normalized);
      expect(row.resolution_note ?? '').not.toContain(upper);
    }

    // (Denetim M3) replacement_messages.body serbest metninde ham e-posta KALMADI + sayaç.
    expect(result.anonymizedMessages).toBeGreaterThanOrEqual(1);
    const msgRemaining = await db.execute<{ id: string }>(sql`
      SELECT m.id FROM replacement_messages m
      JOIN replacement_requests r ON r.id = m.request_id
      WHERE lower(r.customer_email) = ${redacted}
        AND (strpos(m.body, ${email}) > 0 OR strpos(lower(m.body), ${normalized}) > 0)
    `);
    expect((msgRemaining as unknown as unknown[]).length).toBe(0);

    // REGRESYON: email_log.to_email de maskelenmeli (eskiden atlanıyordu).
    const emailRemaining = await db.execute<{ to_email: string }>(sql`
      SELECT to_email FROM email_log WHERE lower(to_email) = ${normalized}
    `);
    expect((emailRemaining as unknown as unknown[]).length).toBe(0);

    const emailRedacted = await db.execute<{ to_email: string; subject: string }>(sql`
      SELECT to_email, subject FROM email_log WHERE lower(to_email) = ${redacted}
    `);
    const emailRedactedList = emailRedacted as unknown as Array<{ to_email: string; subject: string }>;
    expect(emailRedactedList.length).toBeGreaterThanOrEqual(1);
    // Konudaki ham e-posta da temizlendi (subject replace).
    for (const row of emailRedactedList) {
      expect(row.subject).not.toContain(email);
      expect(row.subject).not.toContain(normalized);
    }

    // customers profil satırı silindi.
    const custRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM customers WHERE lower(email) = ${normalized}
    `);
    expect((custRows as unknown as unknown[]).length).toBe(0);

    // Audit izine 'anonymize' düştü; hedef ham e-posta DEĞİL maskedir (sır loglanmaz).
    const auditRows = await db.execute<{ target_id: string }>(sql`
      SELECT target_id FROM audit_log WHERE action = 'anonymize' AND actor = ${actor}
    `);
    const auditList = auditRows as unknown as Array<{ target_id: string }>;
    expect(auditList.length).toBe(1);
    expect(auditList[0]!.target_id).toBe(redacted);
    expect(auditList[0]!.target_id).not.toContain(normalized);
  });

  it('idempotent: zaten anonimleştirilmiş e-posta 2. çağrıda 0 satır etkiler', async () => {
    const result = await service.anonymize(email, actor);
    expect(result.anonymizedOrders).toBe(0);
    expect(result.anonymizedReplacements).toBe(0);
    expect(result.anonymizedEmails).toBe(0);
    // (Denetim M3) 2. çağrıda eşleşen talep yok → mesaj maskeleme de 0 (kapsam talep-id ile sınırlı).
    expect(result.anonymizedMessages).toBe(0);
    // Aynı maske deterministik olarak yeniden üretilir.
    expect(result.redactedEmail).toBe(redacted);
  });
});
