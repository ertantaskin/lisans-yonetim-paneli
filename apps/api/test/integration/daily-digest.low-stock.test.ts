import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { AiSummaryService, type DailyMetrics } from '../../src/ai/ai-summary.service';
import { DailyDigestService } from '../../src/ai/daily-digest.service';
import { LowStockService } from '../../src/notifications/low-stock.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import * as schema from '../../src/db/schema';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  tagPrefix,
} from './_helpers';

/**
 * ENTEGRASYON — günlük özet metrikleri (AiSummaryService) + sabit-eşik alarmlar
 * (DailyDigestService) + düşük stok tespiti (LowStockService).
 *
 * NEDEN BU TESTLER VAR: üçü de tekrarlı (cron/BullMQ) işlerdir ve denetimde "SIFIR test"
 * olarak işaretlendi. Hepsinin ortak riski aynı: "atanabilir stok"un TANIMI. Bu projede
 * tam olarak bu tanım 11 sayım noktasında sapmış ve panel VAR OLMAYAN stok göstermişti.
 * Doğru tanım tek kaynaktan gelir: `assignment/assign.ts` → notExpiredCond() + KAPASİTE
 * (Σ max_uses−use_count), satır sayısı DEĞİL.
 *
 * İZOLASYON: metrikler GLOBAL sayaçlardır (tag'e daraltılamaz) → testler "önce/sonra FARKI"
 * üzerinden doğrular. LowStockService de tüm tabloyu tarar → yalnız kendi ürün id'leri
 * üzerinden doğrulanır. Nest ayağa kaldırılmaz; servisler elle new'lenir.
 */

const { db, end } = makeDb();
const crypto = makeCrypto();
const tag = randomUUID().slice(0, 8);
const like = `${tagPrefix(tag)}-%`;

/** AI KAPALI: dailySummary paragraph=null döner, metrikler yine hesaplanır (§15 graceful). */
const aiSummary = new AiSummaryService(db as never, { enabled: () => false } as never);

/** Telegram env'i olmayan gerçek NotificationsService → sendTelegram no-op, kayıt DB'ye yazılır. */
const notifications = new NotificationsService(db as never, { get: () => undefined } as never);
const lowStock = new LowStockService(db as never, {} as never, notifications);

afterAll(async () => {
  // low_stock bildirimleri meta.sku taşır (tag önekli) → yalnız bu koşunun ürettikleri silinir.
  await db.execute(sql`DELETE FROM notifications WHERE meta->>'sku' LIKE ${like}`);
  await db.execute(sql`DELETE FROM outbox_events WHERE event_type LIKE ${like}`);
  await cleanupByTag(db, tag);
  await end();
});

/** Güncel global metrikleri okur (AI kapalı → yalnız sayımlar). */
async function metrics(): Promise<DailyMetrics> {
  return (await aiSummary.dailySummary()).metrics;
}

describe('AiSummaryService.collectMetrics — "atanabilir stok" tanımı (§3/§12)', () => {
  it('availableStock KAPASİTEYİ sayar (Σ max_uses−use_count), satır sayısını DEĞİL', async () => {
    // REGRESYON: MAK/çok-kullanımlık üründe 1 anahtar 500 kullanım taşır. Sayım satır bazına
    // düşerse (count(*)) günlük özet 500 kullanımlık stoğu "1" gösterir ve kritik düşük-stok
    // alarmı YANLIŞ yere ateşler; tersi durumda (use_count yok sayılırsa) tükenmiş kapasite
    // "stok var" görünür ve alarm HİÇ ateşlemez.
    const product = await createProduct(db, { tag, usageMode: 'multi', maxUses: 500 });
    const before = await metrics();

    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 500,
      payloadPrefix: 'MAK-CAP',
    });
    await db
      .update(schema.licenseItems)
      .set({ useCount: 450 })
      .where(eq(schema.licenseItems.id, itemId!));

    const after = await metrics();

    // Tek SATIR eklendi ama kalan KAPASİTE 50 → fark 50 olmalı (1 değil, 500 değil).
    expect(after.availableStock - before.availableStock).toBe(50);
  });

  it('süresi geçmiş (expires_at <= now) stok "atanabilir" SAYILMAZ', async () => {
    // REGRESYON: notExpiredCond() düşerse panel ATANAMAYACAK kapasiteyi satılabilir gösterir
    // (assign.ts o kalemi zaten seçmez) → "stok var" denir, sipariş pending'e düşer.
    const product = await createProduct(db, { tag });
    const before = await metrics();

    await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 4,
      tag,
      expiresAt: new Date(Date.now() - 60_000), // 1 dk önce öldü → sayılmamalı
      payloadPrefix: 'EXPIRED',
    });
    const afterExpired = await metrics();
    expect(afterExpired.availableStock - before.availableStock).toBe(0);

    // Kontrol denemesi: ömrü SÜREN kalem sayılmalı (yüklem tümünü elemiyor).
    await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 3,
      tag,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      payloadPrefix: 'ALIVE',
    });
    const afterAlive = await metrics();
    expect(afterAlive.availableStock - afterExpired.availableStock).toBe(3);
  });

  it("failedOutbox: 'failed' + 15dk'dan eski 'pending' sayılır; taze pending ve delivered SAYILMAZ", async () => {
    // REGRESYON: bu sayaç /ops dead-letter ekranıyla AYNI semantiği taşımak zorunda (§16).
    // Sapması "sorunlu webhook birikmesi" kritik alarmının yanlış/hiç ateşlemesi demektir.
    const site = await createSite(db, crypto, { tag });
    const before = await metrics();

    const mk = async (status: string, minutesAgo: number): Promise<void> => {
      await db.insert(schema.outboxEvents).values({
        siteId: site.id,
        eventType: `${tagPrefix(tag)}-evt`,
        payload: { tag },
        status,
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
      });
    };

    await mk('failed', 1); // sayılmalı (yaşa bakılmaz)
    await mk('pending', 60); // sayılmalı (15dk+ askıda)
    await mk('pending', 1); // SAYILMAMALI (taze, kuyrukta olabilir)
    await mk('delivered', 60); // SAYILMAMALI (teslim edildi)

    const after = await metrics();
    expect(after.failedOutbox - before.failedOutbox).toBe(2);
  });

  it('todayOrders bugünün siparişini sayar, dünkünü saymaz (yerel gün sınırı)', async () => {
    // REGRESYON: date_trunc('day', now()) yerine "son 24 saat" kullanılırsa özet, sabah 08:00'de
    // dünün akşam siparişlerini "bugün" gösterir (operatör günlük kadansla okuyor).
    const site = await createSite(db, crypto, { tag });
    const product = await createProduct(db, { tag });
    const before = await metrics();

    const today = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
    });
    const yesterday = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 1,
      tag,
    });
    await db
      .update(schema.orders)
      .set({ createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000) })
      .where(eq(schema.orders.id, yesterday.orderId));
    expect(today.orderId).toBeTruthy();

    const after = await metrics();
    expect(after.todayOrders - before.todayOrders).toBe(1);
  });
});

describe('DailyDigestService — sabit/env eşik alarmları (§16)', () => {
  /** Varsayılan (alarm üretmeyen) metrik tabanı; testler yalnız ilgilendikleri alanı ezer. */
  const baseMetrics: DailyMetrics = {
    todayOrders: 3,
    openReplacements: 1,
    securityEvents24h: 0,
    failedOutbox: 0,
    availableStock: 1000,
  };

  /**
   * Verilen metriklerle digest'i koşar; üretilen bildirim girdilerini döndürür.
   * DB'ye dokunmaz: AiSummary + Notifications stub'lanır (eşik mantığı saf fonksiyondur).
   */
  async function runWith(over: Partial<DailyMetrics>): Promise<Array<Record<string, unknown>>> {
    const captured: Array<Record<string, unknown>> = [];
    const digest = new DailyDigestService(
      {} as never,
      {
        dailySummary: async () => ({
          metrics: { ...baseMetrics, ...over },
          paragraph: null,
          aiEnabled: false,
        }),
      } as never,
      {
        sendTelegram: async () => false,
        create: async (input: Record<string, unknown>) => {
          captured.push(input);
          return {};
        },
      } as never,
    );
    const res = await digest.run();
    expect(res.alerts).toBe(captured.length);
    return captured;
  }

  it('eşik altındaki metrikler alarm ÜRETMEZ', async () => {
    // REGRESYON: karşılaştırma yönü ters çevrilirse (>= yerine <=) her gün sahte kritik alarm
    // üretilir → alarm körlüğü, gerçek olay kaçar.
    expect(await runWith({})).toHaveLength(0);
  });

  it('failedOutbox eşiği (vars. 5) AŞILINCA kritik alarm üretilir', async () => {
    const alerts = await runWith({ failedOutbox: 5 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'digest_alert', severity: 'critical' });
    expect((alerts[0]!.meta as Record<string, unknown>).metric).toBe('failedOutbox');

    // 4 < 5 → sınırın altı sessiz.
    expect(await runWith({ failedOutbox: 4 })).toHaveLength(0);
  });

  it('availableStock eşiğe İNİNCE (<=) alarm üretilir; üstünde üretilmez', async () => {
    // REGRESYON: düşük stok alarmı TERS yönlüdür (diğer ikisi "aştıkça", bu "indikçe").
    // Yön karışırsa stok tükenirken hiç alarm gelmez.
    const at = await runWith({ availableStock: 5 }); // == varsayılan eşik
    expect(at).toHaveLength(1);
    expect((at[0]!.meta as Record<string, unknown>).metric).toBe('availableStock');

    expect(await runWith({ availableStock: 6 })).toHaveLength(0);
  });

  it('birden fazla eşik aşılırsa her metrik için AYRI alarm üretilir', async () => {
    const alerts = await runWith({ failedOutbox: 99, securityEvents24h: 99, availableStock: 0 });
    expect(alerts).toHaveLength(3);
    const metricNames = alerts.map((a) => (a.meta as Record<string, unknown>).metric).sort();
    expect(metricNames).toEqual(['availableStock', 'failedOutbox', 'securityEvents24h']);
  });

  it('DIGEST_* env eşiği varsayılanı EZER', async () => {
    const prev = process.env.DIGEST_LOW_STOCK_THRESHOLD;
    process.env.DIGEST_LOW_STOCK_THRESHOLD = '0';
    try {
      // 1 > 0 → alarm YOK (varsayılan 5 ile alarm ÜRETİLİRDİ).
      expect(await runWith({ availableStock: 1 })).toHaveLength(0);
      expect(await runWith({ availableStock: 0 })).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.DIGEST_LOW_STOCK_THRESHOLD;
      else process.env.DIGEST_LOW_STOCK_THRESHOLD = prev;
    }
  });
});

describe('LowStockService.checkLowStock — düşük stok tespiti (§12)', () => {
  /** Bu ürün için üretilmiş 'low_stock' bildirimleri (en yenisi başta). */
  async function noticesFor(productId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await db.execute<{ meta: Record<string, unknown> }>(sql`
      SELECT meta FROM notifications
      WHERE type = 'low_stock' AND meta->>'productId' = ${productId}
      ORDER BY created_at DESC
    `);
    return (rows as unknown as Array<{ meta: Record<string, unknown> }>).map((r) => r.meta);
  }

  it('eşiğin altındaki ürün için bildirim üretilir; eşiğin üstündeki ürün için üretilmez', async () => {
    const low = await createProduct(db, { tag, lowStockThreshold: 5 });
    await insertLicenseItems(db, crypto, {
      productId: low.id,
      count: 3,
      tag,
      payloadPrefix: 'LOW',
    });

    const healthy = await createProduct(db, { tag, lowStockThreshold: 2 });
    await insertLicenseItems(db, crypto, {
      productId: healthy.id,
      count: 10,
      tag,
      payloadPrefix: 'HEALTHY',
    });

    await lowStock.checkLowStock();

    const lowNotices = await noticesFor(low.id);
    expect(lowNotices).toHaveLength(1);
    expect(lowNotices[0]).toMatchObject({ available: 3, threshold: 5 });
    expect(await noticesFor(healthy.id)).toHaveLength(0);
  });

  it('süresi geçmiş kalem "atanabilir" SAYILMAZ → ürün düşük stok olarak yakalanır', async () => {
    // REGRESYON — bu dosyanın en kritik testi: notExpiredCond() yüklemi düşerse ürünün 4 ölü
    // kalemi "stok" sayılır (4 > eşik 2) ve UYARI HİÇ ÜRETİLMEZ; operatör stok var sanarken
    // atama sorgusu (assign.ts) o kalemleri seçemez → siparişler sessizce pending'e düşer.
    // İki farklı bozulma yakalanır: (a) bildirim hiç gelmemesi, (b) gelse bile "available"
    // alanının 4 yazması (bildirimdeki sayı ile gerçeğin ayrışması).
    const product = await createProduct(db, { tag, lowStockThreshold: 2 });
    await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 4,
      tag,
      expiresAt: new Date(Date.now() - 60_000),
      payloadPrefix: 'DEAD',
    });

    await lowStock.checkLowStock();

    const notices = await noticesFor(product.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ available: 0, threshold: 2 });
  });

  it('MAK/çok-kullanımlık üründe KAPASİTE sayılır → tek anahtar "1 adet" sanılmaz', async () => {
    // REGRESYON: sayım satır bazına düşerse (count(*)) 500 kullanımlık tek anahtar taşıyan
    // sağlıklı bir ürün her 30 dakikada bir "düşük stok" alarmı üretir (alarm körlüğü).
    const product = await createProduct(db, {
      tag,
      usageMode: 'multi',
      maxUses: 500,
      lowStockThreshold: 10,
    });
    const [itemId] = await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      maxUses: 500,
      payloadPrefix: 'MAK-LOW',
    });
    await db
      .update(schema.licenseItems)
      .set({ useCount: 450 })
      .where(eq(schema.licenseItems.id, itemId!));

    await lowStock.checkLowStock();

    // Kalan kapasite 50 > eşik 10 → bildirim OLMAMALI (satır sayısı 1 olsaydı olurdu).
    expect(await noticesFor(product.id)).toHaveLength(0);

    // Kapasite eşiğin altına inince yakalanmalı (yüklem tümünü elemiyor — kontrol denemesi).
    await db
      .update(schema.licenseItems)
      .set({ useCount: 495 })
      .where(eq(schema.licenseItems.id, itemId!));
    await lowStock.checkLowStock();
    const notices = await noticesFor(product.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ available: 5, threshold: 10 });
  });

  it('dedupe: 12 saatlik pencerede aynı ürün için İKİNCİ bildirim üretilmez', async () => {
    // REGRESYON: dedupe NOT EXISTS düşerse tarama 30 dakikada bir aynı uyarıyı üretir
    // (gün başına ~48 bildirim/ürün → çan ve Telegram kullanılamaz hâle gelir).
    const product = await createProduct(db, { tag, lowStockThreshold: 5 });
    await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      payloadPrefix: 'DEDUPE',
    });

    await lowStock.checkLowStock();
    await lowStock.checkLowStock();
    await lowStock.checkLowStock();

    expect(await noticesFor(product.id)).toHaveLength(1);
  });

  it('lowStockThreshold NULL olan ürün hiç taranmaz (uyarı KAPALI)', async () => {
    // REGRESYON: IS NOT NULL süzgeci düşerse eşiği olmayan TÜM ürünler için (0 <= NULL
    // karşılaştırması ya da coalesce hatasıyla) gürültü üretilebilir.
    const product = await createProduct(db, { tag }); // lowStockThreshold: null
    await insertLicenseItems(db, crypto, {
      productId: product.id,
      count: 1,
      tag,
      payloadPrefix: 'NOTHRESH',
    });

    await lowStock.checkLowStock();

    expect(await noticesFor(product.id)).toHaveLength(0);
  });
});
