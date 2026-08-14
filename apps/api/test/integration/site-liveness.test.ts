import { randomUUID } from 'node:crypto';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HmacGuard } from '../../src/auth/hmac.guard';
import { SitesService, SITE_LAST_SEEN_THROTTLE_SEC } from '../../src/sites/sites.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { SiteSilenceService } from '../../src/notifications/site-silence.service';
import { CryptoService } from '../../src/crypto/crypto.service';
import * as schema from '../../src/db/schema';
import type { Database } from '../../src/db/db.module';
import { cleanupByTag, createSite, makeCrypto, makeDb, signHmac, tagPrefix, type Db } from './_helpers';

/**
 * ENTEGRASYON — MAĞAZA CANLILIK (sessizlik) izleme + alarm (0040).
 *
 * NEDEN BU TESTLER VAR: geçmişte gerçek bir kesinti GÜNLERCE fark edilmedi — eklenti panele
 * hiç imzalı istek göndermiyordu, panel yine "sağlıklı" görünüyordu. Sinyali üreten yol
 * (HmacGuard → sites.last_seen_at) ve onu okuyan alarm (SiteSilenceService) test edilmezse
 * aynı körlük sessizce geri gelir: yazma düşerse HER mağaza "sessiz" görünür (alarm seli),
 * alarm düşerse HİÇBİRİ görünmez (asıl arıza).
 *
 * Nest ayağa KALDIRILMAZ: guard/servisler gerçek DB + gerçek CryptoService ile elle new'lenir
 * (hmac.guard.test.ts / daily-digest.low-stock.test.ts deseni). Nonce için in-memory sahte
 * Redis yeter (yalnız `set(...,'NX')` semantiği kullanılır).
 */

const tag = randomUUID().slice(0, 8);
const like = `${tagPrefix(tag)}-%`;
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let sites: SitesService;
let silence: SiteSilenceService;

/** Eşik testlerde SABİTLENİR: ortamdaki SITE_SILENCE_HOURS sonucu değiştirmesin. */
const THRESHOLD_HOURS = 24;
let prevSilenceEnv: string | undefined;

const HOUR_MS = 3_600_000;

/** `set(key,'1','EX',ttl,'NX')` semantiği (replay reddi) — gerçek Redis gerekmez. */
function makeFakeRedis(): any {
  const store = new Map<string, string>();
  return {
    async set(key: string, value: string, _ex: string, _ttl: number, mode?: string) {
      if (mode === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
  };
}

function ctxFor(req: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

/** Guard'ın beklediği fastify-benzeri imzalı istek (hmac.guard.test.ts ile aynı yardımcı). */
function reqFor(opts: { apiKey: string; secret: string; path?: string }) {
  const path = opts.path ?? '/v1/orders';
  const signed = signHmac({ method: 'GET', path, apiKey: opts.apiKey, secret: opts.secret });
  return { headers: { ...signed.headers }, method: 'GET', url: path, rawBody: signed.rawBody };
}

async function readSite(siteId: string) {
  const [row] = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).limit(1);
  return row!;
}

async function setLastSeen(siteId: string, at: Date | null): Promise<void> {
  await db.update(schema.sites).set({ lastSeenAt: at }).where(eq(schema.sites.id, siteId));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `last_seen_at` yazımı guard'da FIRE-AND-FORGET'tir (istek beklemez) → assert etmeden önce
 * kısa süre yoklanır. Zaman aşımında null döner (test "yazılmadı" der, asılı kalmaz).
 */
async function waitForLastSeen(siteId: string, timeoutMs = 3000): Promise<Date | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await readSite(siteId);
    if (row.lastSeenAt) return row.lastSeenAt;
    if (Date.now() > deadline) return null;
    await sleep(25);
  }
}

/** Bu site için üretilmiş 'site_silent' bildirimleri (en yenisi başta). */
async function silenceNotices(siteId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.execute<{ meta: Record<string, unknown> }>(sql`
    SELECT meta FROM notifications
    WHERE type = 'site_silent' AND meta->>'siteId' = ${siteId}
    ORDER BY created_at DESC
  `);
  return (rows as unknown as Array<{ meta: Record<string, unknown> }>).map((r) => r.meta);
}

beforeAll(async () => {
  const h = makeDb();
  db = h.db;
  end = h.end;
  crypto = makeCrypto();
  sites = new SitesService(db as unknown as Database, crypto);
  // Telegram env'i olmayan gerçek NotificationsService → sendTelegram no-op, kayıt DB'ye yazılır.
  const notifications = new NotificationsService(db as never, { get: () => undefined } as never);
  // Kuyruk yalnız onModuleInit'te kullanılır (burada çağrılmaz) → boş stub yeterli.
  silence = new SiteSilenceService(db as never, {} as never, notifications);

  prevSilenceEnv = process.env.SITE_SILENCE_HOURS;
  process.env.SITE_SILENCE_HOURS = String(THRESHOLD_HOURS);
});

afterAll(async () => {
  if (prevSilenceEnv === undefined) delete process.env.SITE_SILENCE_HOURS;
  else process.env.SITE_SILENCE_HOURS = prevSilenceEnv;
  // Bildirimler siteye FK ile bağlı değil → tag'li domain üzerinden ayıklanır (meta.domain).
  await db.execute(sql`DELETE FROM notifications WHERE type = 'site_silent' AND meta->>'domain' LIKE ${like}`);
  await cleanupByTag(db, tag);
  await end();
});

describe('HmacGuard → sites.last_seen_at (canlılık yazma yolu)', () => {
  it('(a) imza DOĞRULANINCA last_seen_at yazılır', async () => {
    const site = await createSite(db, crypto, { tag });
    expect((await readSite(site.id)).lastSeenAt).toBeNull(); // henüz hiç bağlanmadı

    const guard = new HmacGuard(sites, makeFakeRedis());
    await expect(
      guard.canActivate(ctxFor(reqFor({ apiKey: site.apiKey, secret: site.hmacSecret }))),
    ).resolves.toBe(true);

    const seen = await waitForLastSeen(site.id);
    expect(seen).not.toBeNull();
    // Damga "şimdi" olmalı (saat kayması değil): son 60 saniye içinde.
    expect(Date.now() - seen!.getTime()).toBeLessThan(60_000);
  });

  it('(b) throttle penceresi içindeki İKİNCİ istek yeniden YAZMAZ', async () => {
    // REGRESYON: throttle düşerse yoğun bir mağazanın HER isteği aynı satırı yeniden yazar
    // (WAL + satır şişmesi + autovacuum baskısı) — sinyalin değeri değişmeden maliyet artar.
    const site = await createSite(db, crypto, { tag });
    const guard = new HmacGuard(sites, makeFakeRedis());

    await guard.canActivate(ctxFor(reqFor({ apiKey: site.apiKey, secret: site.hmacSecret })));
    const first = await waitForLastSeen(site.id);
    expect(first).not.toBeNull();

    // İkinci istek (yeni nonce, geçerli imza) — pencere içinde.
    await expect(
      guard.canActivate(ctxFor(reqFor({ apiKey: site.apiKey, secret: site.hmacSecret }))),
    ).resolves.toBe(true);
    await sleep(300); // fire-and-forget yazım için pay bırak

    expect((await readSite(site.id)).lastSeenAt?.getTime()).toBe(first!.getTime());
  });

  it('(b2) throttle SQL tarafında da uygulanır; pencere dolunca yeniden yazılır', async () => {
    // Guard'ın bayat `req.site` ÖN elemesi atlansa bile (eşzamanlı istekler aynı anlık
    // görüntüyü paylaşabilir) son söz SQL'dedir → servis doğrudan çağrılarak doğrulanır.
    const site = await createSite(db, crypto, { tag });

    await sites.recordLastSeen(site.id);
    const first = (await readSite(site.id)).lastSeenAt;
    expect(first).not.toBeNull();

    await sites.recordLastSeen(site.id); // pencere içinde → no-op
    expect((await readSite(site.id)).lastSeenAt?.getTime()).toBe(first!.getTime());

    // KONTROL DENEMESİ: damgayı pencerenin ötesine iterek yazımın gerçekten açıldığını göster
    // (koşul her şeyi bloklamıyor — "hiç yazmıyor" bozukluğu bu assert ile ayrışır).
    await setLastSeen(site.id, new Date(Date.now() - (SITE_LAST_SEEN_THROTTLE_SEC + 30) * 1000));
    await sites.recordLastSeen(site.id);
    const third = (await readSite(site.id)).lastSeenAt;
    expect(third!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('(c) GEÇERSİZ imzada last_seen_at YAZILMAZ', async () => {
    // GÜVENLİK: doğrulanmamış istek canlılık üretebilseydi, ölü bir mağaza sahte isteklerle
    // "canlı" gösterilip alarm susturulabilirdi (sinyalin kapatılabilir olması, hiç sinyal
    // olmamasından beterdir — operatör "alarm yok" diye güvenir).
    const site = await createSite(db, crypto, { tag });
    const guard = new HmacGuard(sites, makeFakeRedis());
    const wrongSecret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

    await expect(
      guard.canActivate(ctxFor(reqFor({ apiKey: site.apiKey, secret: wrongSecret }))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await sleep(300); // asenkron bir yazım olsaydı bu süre içinde görünürdü
    expect((await readSite(site.id)).lastSeenAt).toBeNull();
  });
});

describe('SiteSilenceService.checkSilence — sessizlik alarmı (§16)', () => {
  it('(d) eşiği aşan site bildirilir; taze olan ve HİÇ bağlanmamış olan bildirilmez', async () => {
    const silentSite = await createSite(db, crypto, { tag });
    const freshSite = await createSite(db, crypto, { tag });
    const neverSite = await createSite(db, crypto, { tag }); // last_seen_at NULL kalır
    const suspended = await createSite(db, crypto, { tag });

    await setLastSeen(silentSite.id, new Date(Date.now() - (THRESHOLD_HOURS + 24) * HOUR_MS));
    await setLastSeen(freshSite.id, new Date(Date.now() - 5 * 60_000)); // 5 dk önce
    // Askıya alınmış sitenin susması BEKLENEN durumdur (HMAC auth zaten reddediliyor).
    await setLastSeen(suspended.id, new Date(Date.now() - (THRESHOLD_HOURS + 24) * HOUR_MS));
    await db
      .update(schema.sites)
      .set({ status: 'suspended' })
      .where(eq(schema.sites.id, suspended.id));

    await silence.checkSilence();

    const notices = await silenceNotices(silentSite.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ domain: silentSite.domain, thresholdHours: THRESHOLD_HOURS });
    expect(Number(notices[0]!.silentHours)).toBeGreaterThanOrEqual(THRESHOLD_HOURS);

    expect(await silenceNotices(freshSite.id)).toHaveLength(0);
    // Kurulum aşamasındaki site her turda alarm üretmemeli (ekranda "hiç bağlanmadı" gösterilir).
    expect(await silenceNotices(neverSite.id)).toHaveLength(0);
    expect(await silenceNotices(suspended.id)).toHaveLength(0);
  });

  it('(e) aynı sessizlik epizodu için İKİNCİ turda mükerrer bildirim üretilmez', async () => {
    // REGRESYON: dedupe düşerse tarama 30 dakikada bir aynı uyarıyı üretir (gün başına ~48
    // bildirim/site → çan ve Telegram kullanılamaz hâle gelir, alarm körlüğü).
    const site = await createSite(db, crypto, { tag });
    await setLastSeen(site.id, new Date(Date.now() - (THRESHOLD_HOURS + 10) * HOUR_MS));

    await silence.checkSilence();
    await silence.checkSilence();
    await silence.checkSilence();

    expect(await silenceNotices(site.id)).toHaveLength(1);
  });

  it('(e2) mağaza tekrar konuşup YENİDEN susarsa yeni epizot için tekrar bildirilir', async () => {
    // Dedupe PENCERE değil EPİZOT tabanlı: `n.created_at > s.last_seen_at`. Bu kontrol denemesi
    // olmasaydı "her zaman sustur" bozukluğu (a) testinden geçer, gerçek ikinci kesinti kaçardı.
    const site = await createSite(db, crypto, { tag });
    await setLastSeen(site.id, new Date(Date.now() - (THRESHOLD_HOURS + 10) * HOUR_MS));
    await silence.checkSilence();
    expect(await silenceNotices(site.id)).toHaveLength(1);

    // İlk bildirimi geçmişe al (3 gün önce) → ardından mağaza 30 saat önce yeniden konuşup
    // tekrar susmuş olsun: last_seen_at artık bildirimden SONRAYA düşer = YENİ epizot.
    await db.execute(sql`
      UPDATE notifications SET created_at = now() - interval '3 days'
      WHERE type = 'site_silent' AND meta->>'siteId' = ${site.id}
    `);
    await setLastSeen(site.id, new Date(Date.now() - (THRESHOLD_HOURS + 6) * HOUR_MS));

    await silence.checkSilence();
    expect(await silenceNotices(site.id)).toHaveLength(2);
  });
});

describe('Okuma yüzeyi — liste/detay canlılık alanları', () => {
  it('detail() lastSeenAt + silent + eşiği döndürür (alarm yüklemiyle aynı karar)', async () => {
    const site = await createSite(db, crypto, { tag });
    const fresh = await sites.detail(site.id);
    expect(fresh.site.lastSeenAt).toBeNull();
    expect(fresh.site.silent).toBe(false); // hiç bağlanmadı ≠ sessiz (kurulum aşaması)
    expect(fresh.site.silenceThresholdHours).toBe(THRESHOLD_HOURS);

    await setLastSeen(site.id, new Date(Date.now() - (THRESHOLD_HOURS + 2) * HOUR_MS));
    const stale = await sites.detail(site.id);
    expect(stale.site.lastSeenAt).not.toBeNull();
    expect(stale.site.silent).toBe(true);

    // Liste ve detay AYNI kararı vermeli (iki ekran çelişmesin).
    const listed = (await sites.list()).find((s) => s.id === site.id);
    expect(listed?.silent).toBe(true);
    expect(listed?.silenceThresholdHours).toBe(THRESHOLD_HOURS);
  });
});
