import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RetentionService } from '../../src/maintenance/retention.service';
import * as schema from '../../src/db/schema';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  makeCrypto,
  makeDb,
  tagPrefix,
} from './_helpers';

/**
 * ENTEGRASYON — saklama/budama motoru (RetentionService), gerçek PostgreSQL'e karşı.
 *
 * NEDEN BU TESTLER VAR: bu servis CANLI veriye karşı GÜNLÜK `DELETE` koşar ve denetimde
 * "SIFIR test" olarak işaretlendi. Bir yüklem kayması (ör. audit budamasının `meta->>'auto'`
 * koşulunu kaybetmesi) GERİ DÖNÜŞSÜZ uyum kaydı kaybı demektir — build/typecheck bunu
 * yakalayamaz, yalnız gerçek DB'ye karşı koşan bir test yakalar.
 *
 * İZOLASYON STRATEJİSİ (önemli): runRetention() tag'e göre daraltılamaz — TÜM tabloyu tarar.
 * Bu yüzden testler kendi satırlarını EŞİĞİN İKİ TARAFINA (ör. 200 gün önce / 10 gün önce)
 * yerleştirir ve YALNIZ kendi id'leri üzerinden doğrular. Diğer test dosyalarının satırları
 * `now()` damgalıdır → hiçbir pencereye girmez, bu koşudan etkilenmez (vitest.integration
 * `fileParallelism:false` ile dosyalar seri koşar).
 *
 * Nest ayağa KALDIRILMAZ: servis elle new'lenir. BullMQ Queue yalnız onModuleInit'te
 * kullanılır (çağrılmıyor → {} stub); ConfigService stub'ı boş döner → VARSAYILAN pencereler
 * (180/30/365/365/730/90 gün + bildirim 180g / dağıtım 365g / bağlan-kodu 7g; audit-tam ve
 * bildirim-tam budama KAPALI) sınanır — üretimde koşan yol budur.
 */

const { db, end } = makeDb();
const crypto = makeCrypto();

/** Boş ConfigService: her anahtar undefined → servis varsayılan pencerelere düşer. */
const emptyConfig = { get: () => undefined } as never;
const retention = new RetentionService(db as never, {} as never, emptyConfig);

const tag = randomUUID().slice(0, 8);
const like = `${tagPrefix(tag)}-%`;

/** n gün önceki zaman damgası (created_at'i elle kurmak için). */
const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

afterAll(async () => {
  // FK'siz/SET NULL'lı tablolar cleanupByTag kapsamında DEĞİL → tag'li satırları elle sil.
  // (fulfillment_events orders'a CASCADE, outbox_events sites'a CASCADE → onlar cleanupByTag'de.)
  await db.execute(sql`DELETE FROM email_log WHERE subject LIKE ${like}`);
  await db.execute(sql`DELETE FROM security_events WHERE detail LIKE ${like}`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor LIKE ${like}`);
  await db.execute(sql`DELETE FROM notifications WHERE title LIKE ${like}`);
  await db.execute(sql`DELETE FROM deployments WHERE requested_by LIKE ${like}`);
  // site_connect_tokens.site_id FK'siz → testin ürettiği siteId'ler cleanupByTag'e girmez.
  await db.execute(sql`DELETE FROM site_connect_tokens WHERE code_hash LIKE ${like}`);
  await cleanupByTag(db, tag);
  await end();
});

/** Bir tabloda verilen id'nin hâlâ var olup olmadığı. */
async function exists(table: string, id: string): Promise<boolean> {
  const rows = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE id = ${id}`,
  );
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0) > 0;
}

describe('RetentionService.runRetention — fulfillment_events / outbox / security', () => {
  it('fulfillment_events: 180g eşiğinin ESKİ tarafı silinir, YENİ tarafı durur', async () => {
    // REGRESYON: pencere yüklemi kayarsa (ör. `<` yerine `>` ya da yanlış birim) ya AKTİF
    // siparişlerin timeline'ı silinir ya da tablo hiç budanmaz (sınırsız büyüme).
    const site = await createSite(db, crypto, { tag });
    const product = await createProduct(db, { tag });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
    });

    const [oldEv] = await db
      .insert(schema.fulfillmentEvents)
      .values({
        orderId: order.orderId,
        type: 'order_received',
        message: `${tagPrefix(tag)}-eski`,
        createdAt: daysAgo(200), // 180g penceresinin DIŞI → silinmeli
      })
      .returning({ id: schema.fulfillmentEvents.id });
    const [freshEv] = await db
      .insert(schema.fulfillmentEvents)
      .values({
        orderId: order.orderId,
        type: 'fulfilled',
        message: `${tagPrefix(tag)}-taze`,
        createdAt: daysAgo(10), // pencere İÇİ → durmalı
      })
      .returning({ id: schema.fulfillmentEvents.id });

    await retention.runRetention();

    expect(await exists('fulfillment_events', oldEv!.id)).toBe(false);
    expect(await exists('fulfillment_events', freshEv!.id)).toBe(true);
  });

  it("outbox_events: yalnız 'delivered' budanır — eski 'failed'/'pending' REPLAY için DURUR", async () => {
    // REGRESYON: status koşulu düşerse teslim EDİLEMEMİŞ webhook'lar silinir → /ops dead-letter
    // ekranından replay edilemez hâle gelir (kalıcı, sessiz veri kaybı — §16).
    const site = await createSite(db, crypto, { tag });

    const mk = async (status: string, days: number): Promise<string> => {
      const [row] = await db
        .insert(schema.outboxEvents)
        .values({
          siteId: site.id,
          eventType: `${tagPrefix(tag)}-evt`,
          payload: { tag },
          status,
          createdAt: daysAgo(days),
        })
        .returning({ id: schema.outboxEvents.id });
      return row!.id;
    };

    const oldDelivered = await mk('delivered', 60); // 30g dışı + delivered → silinmeli
    const freshDelivered = await mk('delivered', 5); // pencere içi → durmalı
    const oldFailed = await mk('failed', 60); // eski AMA teslim edilememiş → DURMALI
    const oldPending = await mk('pending', 60); // eski AMA askıda → DURMALI

    await retention.runRetention();

    expect(await exists('outbox_events', oldDelivered)).toBe(false);
    expect(await exists('outbox_events', freshDelivered)).toBe(true);
    expect(await exists('outbox_events', oldFailed)).toBe(true);
    expect(await exists('outbox_events', oldPending)).toBe(true);
  });

  it('security_events: 365g eşiğinin ESKİ tarafı silinir, YENİ tarafı durur', async () => {
    // REGRESYON: güvenlik izi penceresi daralırsa anomali/kota geçmişi beklenenden erken silinir.
    const [oldEv] = await db
      .insert(schema.securityEvents)
      .values({
        type: 'velocity',
        severity: 'warning',
        detail: `${tagPrefix(tag)}-eski güvenlik olayı`,
        createdAt: daysAgo(400),
      })
      .returning({ id: schema.securityEvents.id });
    const [freshEv] = await db
      .insert(schema.securityEvents)
      .values({
        type: 'velocity',
        severity: 'warning',
        detail: `${tagPrefix(tag)}-taze güvenlik olayı`,
        createdAt: daysAgo(100),
      })
      .returning({ id: schema.securityEvents.id });

    await retention.runRetention();

    expect(await exists('security_events', oldEv!.id)).toBe(false);
    expect(await exists('security_events', freshEv!.id)).toBe(true);
  });
});

describe('RetentionService.runRetention — email_log (KVKK: maskele ≠ sil)', () => {
  /** email_log satırı ekler ve id'sini döndürür. */
  async function insertEmail(days: number, toEmail: string, label: string): Promise<string> {
    const [row] = await db
      .insert(schema.emailLog)
      .values({
        toEmail,
        subject: `${tagPrefix(tag)}-${label}`,
        status: 'sent',
        createdAt: daysAgo(days),
      })
      .returning({ id: schema.emailLog.id });
    return row!.id;
  }

  /** Satırın güncel to_email değeri (satır yoksa null). */
  async function toEmailOf(id: string): Promise<string | null> {
    const [row] = await db
      .select({ toEmail: schema.emailLog.toEmail })
      .from(schema.emailLog)
      .where(eq(schema.emailLog.id, id));
    return row?.toEmail ?? null;
  }

  it('365g: to_email MASKELENİR ama SATIR SİLİNMEZ; 730g: satır silinir; taze satır dokunulmaz', async () => {
    // REGRESYON: bu iki pencere karışırsa ya PII 365g sonra düz metin kalır (KVKK ihlali) ya da
    // maskeleme yerine SİLME yapılır (gönderim/bounce operasyon izi kaybolur, §6).
    const veryOld = await insertEmail(800, 'silinecek@example.test', 'cok-eski');
    const toMask = await insertEmail(400, 'maskelenecek@example.test', 'maskelenecek');
    const fresh = await insertEmail(10, 'taze@example.test', 'taze');

    await retention.runRetention();

    // 730g+ → satır komple gitti.
    expect(await exists('email_log', veryOld)).toBe(false);

    // 365g+ → satır DURUYOR, yalnız adres maskeli (yerel kısmın ilk 2 hanesi + domain).
    expect(await exists('email_log', toMask)).toBe(true);
    expect(await toEmailOf(toMask)).toBe('ma***@example.test');

    // Pencere içi → hiç dokunulmadı.
    expect(await toEmailOf(fresh)).toBe('taze@example.test');
  });

  it('maskeleme idempotenttir: ikinci koşu zaten maskeli adresi TEKRAR maskelemez', async () => {
    // REGRESYON: `NOT LIKE '%***@%'` guard'ı düşerse her koşu maskeyi maskeler
    // ('ma***@x' → 'ma***@x' değil 'ma***@…' zincirlenir) VE batch döngüsü hiç tükenmez
    // (aynı satırlar her turda tekrar seçilir → sonsuz/tavan-dolduran koşu).
    const id = await insertEmail(400, 'tekrar@example.test', 'idempotent');

    await retention.runRetention();
    const first = await toEmailOf(id);
    expect(first).toBe('te***@example.test');

    await retention.runRetention();
    expect(await toEmailOf(id)).toBe(first);
  });

  it('KVKK ile anonimleştirilmiş adres (@redacted.invalid) YENİDEN maskelenmez', async () => {
    // REGRESYON (bu turda düzeltildi): compliance.anonymize adresi DETERMİNİSTİK takma ada
    // çevirir (`anon-<hash>@redacted.invalid`) — "aynı kişi = aynı maske" bilinçli tasarımdır.
    // Retention maskesi bunu `an***@redacted.invalid` yapıp takma ad bağını GERİ DÖNÜŞSÜZ
    // yok ediyordu (satır zaten PII taşımıyordu, kazanç sıfır; kayıp kalıcı).
    const anon = 'anon-0123456789ab@redacted.invalid';
    const id = await insertEmail(400, anon, 'anonim');

    await retention.runRetention();

    expect(await exists('email_log', id)).toBe(true);
    expect(await toEmailOf(id)).toBe(anon);
  });
});

describe('RetentionService.runRetention — audit_log (uyum kaydı KORUNUR)', () => {
  /** audit_log satırı ekler ve id'sini döndürür. */
  async function insertAudit(opts: {
    action: (typeof schema.auditLog.$inferInsert)['action'];
    meta: Record<string, unknown> | null;
    days: number;
  }): Promise<string> {
    const [row] = await db
      .insert(schema.auditLog)
      .values({
        action: opts.action,
        actor: `${tagPrefix(tag)}-actor`,
        targetType: 'test',
        meta: opts.meta,
        createdAt: daysAgo(opts.days),
      })
      .returning({ id: schema.auditLog.id });
    return row!.id;
  }

  it('yalnız GÜRÜLTÜ (auto-reveal) budanır; GERÇEK denetim kaydı SİLİNMEZ', async () => {
    // REGRESYON — bu dosyanın en kritik testi: yüklem `action='reveal' AND meta->>'auto'='true'`
    // dar tutulmalı. Yüklem kayarsa (ör. yalnız `action='reveal'` kalırsa ya da meta koşulu
    // NULL-güvenli olmayan bir biçime dönerse) OPERATÖRÜN ELLE yaptığı ifşa kayıtları ve/veya
    // revoke/import/login gibi uyum kayıtları GERİ DÖNÜŞSÜZ silinir (§8 append-only denetim izi).
    const noiseOld = await insertAudit({ action: 'reveal', meta: { auto: true }, days: 200 });
    const noiseFresh = await insertAudit({ action: 'reveal', meta: { auto: true }, days: 10 });
    // Elle ifşa: admin bir anahtarı bilinçli gösterdi → meta'da 'auto' YOK (NULL karşılaştırması).
    const manualReveal = await insertAudit({
      action: 'reveal',
      meta: { licenseItemId: 'x', kind: 'key' },
      days: 200,
    });
    // Açıkça auto=false yazılmış bir kayıt da gürültü değildir.
    const explicitFalse = await insertAudit({ action: 'reveal', meta: { auto: false }, days: 200 });
    // meta tamamen NULL → `meta->>'auto'` NULL → yükleme GİRMEMELİ.
    const nullMeta = await insertAudit({ action: 'reveal', meta: null, days: 200 });
    // Başka aksiyonlar: auto bayrağı taşısalar bile action 'reveal' değil → DURMALI.
    const revoke = await insertAudit({ action: 'revoke', meta: { auto: true }, days: 200 });
    const importAudit = await insertAudit({ action: 'import', meta: { rows: 5 }, days: 200 });
    const login = await insertAudit({ action: 'login', meta: null, days: 200 });

    await retention.runRetention();

    // Silinen TEK küme: eski auto-reveal gürültüsü.
    expect(await exists('audit_log', noiseOld)).toBe(false);

    // Geri kalan HER ŞEY duruyor.
    expect(await exists('audit_log', noiseFresh)).toBe(true);
    expect(await exists('audit_log', manualReveal)).toBe(true);
    expect(await exists('audit_log', explicitFalse)).toBe(true);
    expect(await exists('audit_log', nullMeta)).toBe(true);
    expect(await exists('audit_log', revoke)).toBe(true);
    expect(await exists('audit_log', importAudit)).toBe(true);
    expect(await exists('audit_log', login)).toBe(true);
  });

  it('RETENTION_AUDIT_ALL_DAYS set DEĞİLKEN tam budama KAPALI kalır (auditAllDeleted = 0)', async () => {
    // REGRESYON: "tehlikeli" budamanın varsayılanı KAPALI olmalı. optionalDays() yanlışlıkla
    // bir varsayılana düşerse (days() ile karıştırılırsa) tüm denetim izi sessizce budanır.
    const old = await insertAudit({ action: 'assign', meta: { k: 1 }, days: 3000 });

    const report = await retention.runRetention();

    expect(report.auditAllDeleted).toBe(0);
    expect(await exists('audit_log', old)).toBe(true);
  });
});

describe('RetentionService.runRetention — notifications / deployments / connect tokens', () => {
  /** notifications satırı ekler (okundu bilgisi + yaş kontrollü). */
  async function insertNotification(opts: {
    days: number;
    read: boolean;
    label: string;
  }): Promise<string> {
    const [row] = await db
      .insert(schema.notifications)
      .values({
        type: 'low_stock',
        severity: 'warning',
        title: `${tagPrefix(tag)}-${opts.label}`,
        message: 'test',
        readAt: opts.read ? daysAgo(opts.days) : null,
        createdAt: daysAgo(opts.days),
      })
      .returning({ id: schema.notifications.id });
    return row!.id;
  }

  it('notifications: OKUNMUŞ + eski budanır; OKUNMAMIŞ olan yaşı ne olursa olsun DURUR', async () => {
    // REGRESYON: `read_at IS NOT NULL` koşulu düşerse operatörün HİÇ görmediği düşük-stok /
    // kritik alarm bildirimleri sessizce silinir (bu projede "sessiz kayıp" yasak). Ters yönde,
    // pencere koşulu düşerse yeni okunan bildirimler anında kaybolur (çan geçmişi boşalır).
    const oldRead = await insertNotification({ days: 200, read: true, label: 'eski-okundu' });
    const oldUnread = await insertNotification({ days: 400, read: false, label: 'eski-okunmadi' });
    const freshRead = await insertNotification({ days: 10, read: true, label: 'taze-okundu' });

    const report = await retention.runRetention();

    expect(await exists('notifications', oldRead)).toBe(false);
    expect(await exists('notifications', oldUnread)).toBe(true);
    expect(await exists('notifications', freshRead)).toBe(true);
    // Tam budama (okunmamışlar dahil) VARSAYILAN KAPALI olmalı — audit_log 5b ile aynı kural.
    expect(report.notificationsAllDeleted).toBe(0);
  });

  it("deployments: 'success'/'failed' budanır; 'pending'/'running' ASLA silinmez", async () => {
    // REGRESYON — en kritiği: bu tablo "aynı anda tek aktif dağıtım" kilidinin kendisidir.
    // Aktif bir satır silinirse koşan dağıtımın sonucu yazılamaz ve kuyruk mantığı bozulur.
    const mk = async (status: string, days: number): Promise<string> => {
      const [row] = await db
        .insert(schema.deployments)
        .values({
          target: 'api',
          status,
          requestedBy: `${tagPrefix(tag)}-deploy`,
          createdAt: daysAgo(days),
        })
        .returning({ id: schema.deployments.id });
      return row!.id;
    };

    const oldSuccess = await mk('success', 400);
    const oldFailed = await mk('failed', 400);
    const freshSuccess = await mk('success', 10);
    const oldPending = await mk('pending', 400); // eski AMA aktif → DURMALI
    const oldRunning = await mk('running', 400); // eski AMA aktif → DURMALI

    await retention.runRetention();

    expect(await exists('deployments', oldSuccess)).toBe(false);
    expect(await exists('deployments', oldFailed)).toBe(false);
    expect(await exists('deployments', freshSuccess)).toBe(true);
    expect(await exists('deployments', oldPending)).toBe(true);
    expect(await exists('deployments', oldRunning)).toBe(true);
  });

  it('site_connect_tokens: tüketilmiş/çoktan süresi geçmiş budanır, CANLI kod DOKUNULMAZ', async () => {
    // REGRESYON: pencere koşulu düşerse HENÜZ KULLANILMAMIŞ ve süresi dolmamış bir bağlan kodu
    // silinir → operatörün elindeki kod "geçersiz" olur ve onboarding akışı kırılır (§14).
    const mk = async (opts: {
      consumedDaysAgo?: number;
      expiresInDays: number;
      label: string;
    }): Promise<string> => {
      const [row] = await db
        .insert(schema.siteConnectTokens)
        .values({
          siteId: randomUUID(), // FK YOK (şema notu) → gerçek site gerekmez
          codeHash: `${tagPrefix(tag)}-${opts.label}`,
          expiresAt: new Date(Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000),
          consumedAt:
            opts.consumedDaysAgo === undefined ? null : daysAgo(opts.consumedDaysAgo),
        })
        .returning({ id: schema.siteConnectTokens.id });
      return row!.id;
    };

    const oldConsumed = await mk({ consumedDaysAgo: 30, expiresInDays: -30, label: 'eski-kullanildi' });
    const longExpired = await mk({ expiresInDays: -30, label: 'cok-eski-suresi-gecti' });
    // Yeni tüketilmiş: kullanılmış ama 7g penceresi dolmadı → henüz DURMALI (operasyon izi).
    const freshConsumed = await mk({ consumedDaysAgo: 1, expiresInDays: -1, label: 'yeni-kullanildi' });
    // CANLI kod: tüketilmemiş + süresi dolmamış → HİÇBİR dala girmemeli.
    const live = await mk({ expiresInDays: 1, label: 'canli' });

    await retention.runRetention();

    expect(await exists('site_connect_tokens', oldConsumed)).toBe(false);
    expect(await exists('site_connect_tokens', longExpired)).toBe(false);
    expect(await exists('site_connect_tokens', freshConsumed)).toBe(true);
    expect(await exists('site_connect_tokens', live)).toBe(true);
  });
});

describe('RetentionService.runRetention — idempotans', () => {
  it('silinecek/maskelenecek bir şey yoksa TÜM sayaçlar 0 döner ve hata atmaz', async () => {
    // REGRESYON: batch döngüsünün bitiş koşulu (n < BATCH_SIZE) bozulursa ya da bir yüklem
    // kendi yazdığı satırı tekrar seçerse (maskeleme guard'ı gibi) ikinci koşu ASLA sıfırlanmaz
    // ve günlük iş sonsuza dek dönmeye çalışır.
    await retention.runRetention(); // 1. koşu: ne kaldıysa temizler
    const second = await retention.runRetention(); // 2. koşu: yapacak iş yok

    expect(second).toEqual({
      fulfillmentEventsDeleted: 0,
      outboxDeleted: 0,
      securityEventsDeleted: 0,
      emailMasked: 0,
      emailDeleted: 0,
      // Kapanmış tedarikçi fişindeki düz metin anahtar maskesi de idempotent olmalı: maskelenen
      // satır ('[saklama süresi doldu]') bir daha yükleme girmez, aksi halde günlük iş her
      // koşuda aynı satırları yeniden yazardı (ve sayaç asla 0'a inmezdi).
      claimKeysMasked: 0,
      auditRevealDeleted: 0,
      auditAllDeleted: 0,
      notificationsDeleted: 0,
      notificationsAllDeleted: 0,
      deploymentsDeleted: 0,
      connectTokensDeleted: 0,
      // Eklenti paketi arşivlemesi de idempotent: gövdesi boşaltılan satır bir daha aday
      // kümesine girmez (sorgu `zip_b64 <> ''` süzer), aksi halde her koşuda aynı satırlar
      // yeniden yazılırdı. Bu testin verisinde yayın yok → zaten 0.
      pluginZipsArchived: 0,
    });
  });
});

/*
 * TEDARİKÇİ FİŞİ — düz metin anahtarın maskelenmesi (§9).
 *
 * NEDEN VAR: `supplier_claim_items.key_snapshot`, tedarikçiye gönderilen raporun kanıtı olsun
 * diye ölü anahtarın DÜZ METİN kopyasını tutar. `license_items.payload_enc` ŞİFRELİYKEN bu kolon
 * şifresizdir ve hiç budanmıyordu → düz metin lisans değerleri veritabanında (ve her yedekte)
 * SÜRESİZ birikiyordu. İdempotans testi tek başına YETMEZ: maskeleme adımı hiç çalışmasa da o
 * test geçerdi (veri yokken tüm sayaçlar zaten 0). Bu test gerçek davranışı kilitler.
 */
describe('RetentionService — tedarikçi fişi düz metin anahtar maskesi', () => {
  it('KAPANMIŞ ve eski fişte maskeler; AÇIK fişe ve YENİ kapanmışa DOKUNMAZ', async () => {
    const claimTag = `${tagPrefix(tag)}-claim-${randomUUID().slice(0, 6)}`;
    const KEY = 'GERCEK-ANAHTAR-1234';
    const MASK = '[saklama süresi doldu]';

    /** Fiş + tek kalem kurar. `closedAt` null ise fiş AÇIK sayılır. */
    async function seedClaim(opts: {
      status: 'closed' | 'canceled' | 'sent';
      closedDaysAgo: number | null;
    }): Promise<string> {
      const [claim] = await db
        .insert(schema.supplierClaims)
        .values({
          code: `${claimTag}-${randomUUID().slice(0, 4)}`,
          status: opts.status,
          itemCount: 1,
          createdBy: claimTag,
          note: claimTag,
          // created_at da eski olmalı: fiş hiç kapanmadıysa yüklem coalesce ile buna düşer.
          createdAt: sql`now() - interval '800 days'` as never,
          closedAt:
            opts.closedDaysAgo === null
              ? null
              : (sql`now() - (${opts.closedDaysAgo} * interval '1 day')` as never),
        })
        .returning({ id: schema.supplierClaims.id });
      const [item] = await db
        .insert(schema.supplierClaimItems)
        .values({
          claimId: claim!.id,
          licenseItemId: randomUUID(),
          keySnapshot: KEY,
          reason: claimTag,
        })
        .returning({ id: schema.supplierClaimItems.id });
      return item!.id;
    }

    const keyOf = async (itemId: string): Promise<string | null> => {
      const [row] = await db
        .select({ k: schema.supplierClaimItems.keySnapshot })
        .from(schema.supplierClaimItems)
        .where(eq(schema.supplierClaimItems.id, itemId))
        .limit(1);
      return row?.k ?? null;
    };

    // (a) KAPANMIŞ + eşiğin ötesinde (varsayılan 365g) → maskelenmeli.
    const oldClosed = await seedClaim({ status: 'closed', closedDaysAgo: 400 });
    // (b) KAPANMIŞ ama YENİ (eşiğin içinde) → dokunulmamalı.
    const recentClosed = await seedClaim({ status: 'closed', closedDaysAgo: 10 });
    // (c) AÇIK fiş (gönderildi, henüz kapanmadı) → rapor hâlâ indirilebilir olmalı, DOKUNULMAZ.
    //     created_at 800 gün eski: yalnız durum sayesinde korunduğu kanıtlanır.
    const stillOpen = await seedClaim({ status: 'sent', closedDaysAgo: null });
    // (d) İPTAL edilmiş + eski → 'canceled' de terminal durumdur, maskelenmeli.
    const oldCanceled = await seedClaim({ status: 'canceled', closedDaysAgo: 500 });

    const report = await retention.runRetention();
    expect(report.claimKeysMasked).toBeGreaterThanOrEqual(2);

    expect(await keyOf(oldClosed)).toBe(MASK);
    expect(await keyOf(oldCanceled)).toBe(MASK);
    // Bu ikisi DEĞİŞMEMELİ — aksi halde açık bir uyuşmazlıkta kanıt metni kaybolurdu.
    expect(await keyOf(recentClosed)).toBe(KEY);
    expect(await keyOf(stillOpen)).toBe(KEY);

    // İdempotans: ikinci koşu aynı satırları TEKRAR maskelemeye çalışmamalı (sonsuz yazma).
    const second = await retention.runRetention();
    expect(second.claimKeysMasked).toBe(0);
    // NOT: aşağıdaki "özet satırı" testi bu koşumun ürettiği raporu kullanmaz — kendi koşusunu yapar.

    // Temizlik: bu dosyanın kendi satırları (cleanupByTag fiş tablolarını kapsamıyor).
    await db.execute(
      sql`DELETE FROM supplier_claims WHERE created_by = ${claimTag}`,
    );
  });
});

describe('RetentionService.runRetention — operatöre görünen özet satırı', () => {
  /**
   * NEDEN BU TEST VAR (gerçek hata): `claimKeysMasked` adımı eklenirken özet satırındaki
   * `${...}` interpolasyonları KAYBOLDU (commit dec4c91) → süpürmenin operatöre görünen TEK
   * satırı üç adım için boş değer basıyordu ("security= sil, email= maske/ sil"). Kod
   * çalışıyordu, testler geçiyordu, typecheck geçiyordu — yalnız gözlem YALAN söylüyordu.
   * Bu, projenin en sık tekrarlayan hata sınıfı: "sistem sessizce yanlış bir şey söylüyor".
   *
   * Bu test log METNİNİ ezberlemez (kırılgan olurdu); raporun HER sayısının satırda
   * gerçekten geçtiğini doğrular → yeni bir adım eklenip özete yazılmayı unutursa da yakalar.
   */
  it('özet satırı raporun HER sayısını taşır (kayıp interpolasyon regresyonu)', async () => {
    const messages: string[] = [];
    const spy = vi
      .spyOn((retention as unknown as { logger: { log: (m: string) => void } }).logger, 'log')
      .mockImplementation((m: string) => {
        messages.push(String(m));
      });

    let report: Awaited<ReturnType<typeof retention.runRetention>>;
    try {
      report = await retention.runRetention();
    } finally {
      spy.mockRestore();
    }

    const summary = messages.find((m) => m.startsWith('Saklama koşusu bitti:'));
    expect(summary, 'özet satırı hiç loglanmadı').toBeDefined();
    const line = summary as string;

    // Etiket+değer çiftleri: değer 0 olsa bile "etiket=0" geçmeli. Kayıp interpolasyonda
    // satırda "security= sil" olur ve "security=0" ARANDIĞINDA bulunamaz → test KIRMIZI.
    expect(line).toContain(`fulfillment=${report.fulfillmentEventsDeleted} sil`);
    expect(line).toContain(`outbox=${report.outboxDeleted} sil`);
    expect(line).toContain(`security=${report.securityEventsDeleted} sil`);
    expect(line).toContain(`email=${report.emailMasked} maske/${report.emailDeleted} sil`);
    expect(line).toContain(`fis anahtari=${report.claimKeysMasked} maske`);
    expect(line).toContain(`audit auto-reveal=${report.auditRevealDeleted} sil`);
    expect(line).toContain(`bildirim=${report.notificationsDeleted} sil`);
    expect(line).toContain(`dagitim=${report.deploymentsDeleted} sil`);
    expect(line).toContain(`baglan-kodu=${report.connectTokensDeleted} sil`);

    // Savunma derinliği: hiçbir etiket DEĞERSİZ kalmamalı ("etiket=" hemen ardından boşluk/
    // virgül/satır sonu gelirse interpolasyon kaybolmuş demektir).
    expect(line).not.toMatch(/=(?=[\s,)]|$)/);
  });
});

describe('RetentionService.runRetention — plugin_releases .zip arşivleme', () => {
  /**
   * NEDEN BU TESTLER VAR: eklenti paketleri base64 olarak DB'de tutulur ve bu tablo saklama
   * kapsamı DIŞINDAYDI → her yayınla kalıcı ~108 KB büyüyordu (ölçüldü: prod'da 18 yayının
   * gövdesi 1947 kB, gecelik yedek dosyası 1,1 MB — yedeğin neredeyse tamamı tarihî zip'ler).
   *
   * KRİTİK İNVARYANT: müşteri siteleri güncellemede EN YÜKSEK SEMVER'in paketini indirir.
   * Yalnız `created_at`e göre budamak, sırasız yayında (1.4.0'dan sonra hotfix 1.3.9) CANLI
   * güncelleme paketini silebilirdi — bu yüzden semver-en-yüksek her hâlükârda korunur ve
   * aşağıdaki ilk assert tam olarak onu kilitler.
   *
   * NOT: `= ANY(${dizi})` biçimi drizzle `sql` şablonunda BOZUK SQL üretir (bu projede iki kez
   * yaşandı) → küme sorguları `inArray` ile kurulur.
   */
  const V_HIGH = '900.1.0'; // EN YÜKSEK semver ama EN ESKİ kayıt
  const V_OLD = '900.0.1';
  const V_MID = '900.0.2';
  const V_NEW = '900.0.3';
  const ALL_V = [V_HIGH, V_OLD, V_MID, V_NEW];

  /** keep=2 döndüren ConfigService stub'ı ile ayrı servis örneği (varsayılan 20'yi ezer). */
  const keep2Config = {
    get: (name: string) => (name === 'RETENTION_PLUGIN_RELEASE_KEEP' ? '2' : undefined),
  } as never;
  const retentionKeep2 = new RetentionService(db as never, {} as never, keep2Config);

  /** Sürümün .zip gövdesi hâlâ dolu mu? */
  async function hasBody(version: string): Promise<boolean> {
    const [row] = await db
      .select({ zipB64: schema.pluginReleases.zipB64 })
      .from(schema.pluginReleases)
      .where(eq(schema.pluginReleases.version, version))
      .limit(1);
    return Boolean(row?.zipB64);
  }

  afterAll(async () => {
    await db
      .delete(schema.pluginReleases)
      .where(inArray(schema.pluginReleases.version, ALL_V));
  });

  it('EN YÜKSEK SEMVER korunur (tarihçe en eski olsa bile); pencere dışı sürüm arşivlenir', async () => {
    await db.insert(schema.pluginReleases).values([
      { version: V_HIGH, changelog: null, zipB64: 'AAAA', createdAt: daysAgo(100) },
      { version: V_OLD, changelog: null, zipB64: 'BBBB', createdAt: daysAgo(3) },
      { version: V_MID, changelog: null, zipB64: 'CCCC', createdAt: daysAgo(2) },
      { version: V_NEW, changelog: null, zipB64: 'DDDD', createdAt: daysAgo(1) },
    ]);

    const report = await retentionKeep2.runRetention();
    expect(report.pluginZipsArchived).toBeGreaterThanOrEqual(1);

    // KRİTİK: canlı güncelleme paketi. Bu assert kırmızıysa müşteri siteleri güncelleyemez.
    expect(await hasBody(V_HIGH)).toBe(true);
    // En yeni iki KAYIT (created_at) korunur — geri alma derinliği.
    expect(await hasBody(V_NEW)).toBe(true);
    expect(await hasBody(V_MID)).toBe(true);
    // Pencerenin dışında kalan ve semver-en-yüksek OLMAYAN tek sürüm arşivlenir.
    expect(await hasBody(V_OLD)).toBe(false);
  });

  it('idempotent: ikinci koşu aynı satırları TEKRAR arşivlemeye çalışmaz', async () => {
    const second = await retentionKeep2.runRetention();
    expect(second.pluginZipsArchived).toBe(0);
  });

  it('satır SİLİNMEZ — sürüm geçmişi panelde görünür kalır', async () => {
    const rows = await db
      .select({ version: schema.pluginReleases.version })
      .from(schema.pluginReleases)
      .where(inArray(schema.pluginReleases.version, ALL_V));
    expect(rows).toHaveLength(4);
  });
});
