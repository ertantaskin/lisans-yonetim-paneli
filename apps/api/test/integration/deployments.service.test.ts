import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConflictException } from '@nestjs/common';
import { makeDb, type Db } from './_helpers';
import { DeploymentsService } from '../../src/deployments/deployments.service';

/**
 * DeploymentsService entegrasyon testi (§16 panelden dağıtım). Gerçek PG.
 * deployments tablosunun tag kolonu yok → kendi requested_by damgamızla temizleriz.
 * request() guard'ı GLOBAL aktif (pending/running) kontrolü yaptığından beforeAll'da
 * zombi aktif kayıtları temizleriz (izole test DB'sinde güvenli).
 */
describe('DeploymentsService (integration)', () => {
  let db: Db;
  let end: () => Promise<void>;
  let svc: DeploymentsService;
  const actor = 'it-deploy-test';

  beforeAll(async () => {
    ({ db, end } = makeDb());
    svc = new DeploymentsService(db as never);
    await db.execute(sql`DELETE FROM deployments WHERE status IN ('pending','running')`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM deployments WHERE requested_by = ${actor}`);
    await end();
  });

  it('request→pending, tek-aktif 409, claim→running, tekrar claim boş, finish→success', async () => {
    const d1 = await svc.request('api', actor);
    expect(d1.status).toBe('pending');
    expect(d1.target).toBe('api');
    expect(d1.requestedBy).toBe(actor);

    // Aynı anda yalnız bir aktif dağıtım → ikinci istek 409.
    await expect(svc.request('admin', actor)).rejects.toBeInstanceOf(ConflictException);

    // Runner claim → pending'i running yapar (aynı id).
    const claimed = await svc.claimNext();
    expect(claimed?.id).toBe(d1.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.startedAt).toBeTruthy();

    // Bekleyen kalmadı → ikinci claim boş.
    expect(await svc.claimNext()).toBeNull();

    // Sonuç yaz → success.
    const done = await svc.finish(d1.id, 'success', { gitSha: 'abc1234def', log: 'deploy ok' });
    expect(done?.status).toBe('success');
    expect(done?.gitSha).toBe('abc1234def');
    expect(done?.finishedAt).toBeTruthy();

    // Aktif kalmadı → yeni istek kabul (kilit açıldı).
    const d2 = await svc.request('admin', actor);
    expect(d2.status).toBe('pending');
    await svc.claimNext();
    await svc.finish(d2.id, 'failed', { error: 'test' });
  });

  it('geçersiz hedef reddedilir', async () => {
    await expect(svc.request('sunucu', actor)).rejects.toThrow();
  });

  it('30dk takılı "running" claimNext ile otomatik "failed" olur (self-heal)', async () => {
    const ins = await db.execute(sql`
      INSERT INTO deployments (target, status, requested_by, started_at, created_at)
      VALUES ('api', 'running', ${actor}, now() - interval '40 minutes', now() - interval '40 minutes')
      RETURNING id
    `);
    const stuckId = (ins[0] as { id: string }).id;

    // claimNext önce zombiyi failed yapar; bekleyen olmadığından null döner.
    expect(await svc.claimNext()).toBeNull();

    const after = await db.execute(sql`SELECT status FROM deployments WHERE id = ${stuckId}`);
    expect((after[0] as { status: string }).status).toBe('failed');

    // Zombi temizlendiğine göre yeni istek yeniden kabul edilir.
    const d3 = await svc.request('api admin', actor);
    expect(d3.status).toBe('pending');
    await svc.claimNext();
    await svc.finish(d3.id, 'success', {});
  });

  /**
   * HANGİ REGRESYONU YAKALAR: tek bir claim ASLA birden çok isteği 'running' yapmamalı.
   *
   * `claimNext` bir dönem `UPDATE … WHERE id = (SELECT … LIMIT 1 FOR UPDATE SKIP LOCKED)`
   * yazımını kullanıyordu — atama motorunda ÖLÇÜLEN aşırı teslimat hatasıyla aynı sınıf:
   * kilit yan etkisi taşıyan alt sorgu dış taramanın satırları için yeniden koşabilir ve her
   * koşuda BİR SONRAKİ bekleyeni seçer. `.returning()` yalnız ilk satırı döndürdüğü için
   * fazladan claim edilenler SESSİZCE öksüz 'running' kalır: "aynı anda tek aktif iş"
   * güvencesi yüzünden panelden yeni dağıtım 409 alır ve kilit ancak zombi süpürmesiyle açılır.
   *
   * Birden çok bekleyen satır `request()` ile üretilemez (guard tek aktif işe izin verir) →
   * durum doğrudan INSERT ile kurulur; ölçülen şey claim'in KENDİSİDİR.
   *
   * DÜRÜSTLÜK NOTU (testin gücü): bu bir İNVARYANT KİLİDİDİR, arızanın YENİDEN ÜRETİMİ değil.
   * Eski yazımın kaçağı EvalPlanQual'a, yani araya giren EŞZAMANLI bir yazara bağlıdır; bu test
   * eşzamanlılık kurmadığı için eski kodla da yeşil kalırdı (kontrol denemesi yapılmadı, çünkü
   * sonucu belirleyen şey testin kendisi değil zamanlama). Düzeltmenin gerekçesi yapısaldır:
   * kilit yan etkili alt sorgu bir `UPDATE`in WHERE'inde durmamalıdır — aynı sınıf, atama
   * motorunda ÖLÇÜLMÜŞ bir üretim hatası üretmişti. Test, ileride birinin tek-ifade yazımına
   * geri dönmesini engellemez; "bir claim = bir running" beklentisini belgeler ve FIFO'yu kilitler.
   */
  it('birden çok bekleyen varken tek claim YALNIZ birini running yapar', async () => {
    await db.execute(sql`DELETE FROM deployments WHERE status IN ('pending','running')`);
    await db.execute(sql`
      INSERT INTO deployments (target, status, requested_by, created_at) VALUES
        ('api',       'pending', ${actor}, now() - interval '3 minutes'),
        ('admin',     'pending', ${actor}, now() - interval '2 minutes'),
        ('api admin', 'pending', ${actor}, now() - interval '1 minutes')
    `);

    const claimed = await svc.claimNext();
    // En eski bekleyen alınır (FIFO).
    expect(claimed?.target).toBe('api');
    expect(claimed?.status).toBe('running');

    const counts = await db.execute(sql`
      SELECT status, count(*)::int AS n FROM deployments
      WHERE requested_by = ${actor} AND status IN ('pending','running')
      GROUP BY status
    `);
    const byStatus = Object.fromEntries(
      (counts as unknown as { status: string; n: number }[]).map((r) => [r.status, r.n]),
    );
    expect(byStatus.running).toBe(1);
    expect(byStatus.pending).toBe(2);

    await db.execute(sql`DELETE FROM deployments WHERE requested_by = ${actor}`);
  });

  /**
   * HANGİ REGRESYONU YAKALAR — SESSİZ KIRPMA: `list()` bir dönem hedef süzgeci KABUL ETMİYOR
   * ve sabit 50'lik pencere döndürüyordu. Dağıtım, eklenti yayını ve gecelik yedek işleri AYNI
   * kuyruktadır; yedek cron'u her gün en az bir satır yazdığı için pencere ~50 günde tamamen
   * yedek kayıtlarıyla dolar → `/releases` ekranı, geçmişte GERÇEKTEN yapılmış yayınlar
   * dururken "Henüz yayın işi yok" derdi. Süzgeç artık SUNUCUDA: pencere hedef BAŞINA dolar.
   *
   * Senaryo tam olarak o arızayı kurar: 60 `backup` satırının ARDINDAN yazılmış (yani daha
   * YENİ) hiçbir plugin satırı yok — eski davranışta plugin işi 50'lik pencerenin dışında
   * kalırdı.
   *
   * KONTROL DENEYİ TESTİN İÇİNDE: ilk beklenti, aynı pencerede süzgeçSİZ çağrının plugin
   * satırını GÖRMEDİĞİNİ ölçer. Yani düzeltme geri alınıp süzgeçli çağrı `list(50)`e
   * dönseydi ikinci beklenti zorunlu olarak kırmızı olurdu — "bu test regresyonu yakalar"
   * iddiası varsayım değil, aynı dosyada kanıtlanmış oluyor.
   */
  it('list(target) sessiz kırpmayı bitirir: yedek gürültüsü yayın işini pencereden atamaz', async () => {
    await db.execute(sql`DELETE FROM deployments WHERE requested_by = ${actor}`);
    // ESKİ (pencere dışına düşecek) yayın işi + üstüne 60 taze yedek satırı.
    await db.execute(sql`
      INSERT INTO deployments (target, status, requested_by, created_at)
      VALUES ('plugin', 'success', ${actor}, now() - interval '90 days')
    `);
    await db.execute(sql`
      INSERT INTO deployments (target, status, requested_by, created_at)
      SELECT 'backup', 'success', ${actor}, now() - (g * interval '1 hour')
      FROM generate_series(1, 60) AS g
    `);

    // Süzgeçsiz: 50'lik pencere yalnız yedeklerle dolar → plugin işi GÖRÜNMEZ (eski arıza).
    const unfiltered = await svc.list(50);
    expect(unfiltered.filter((r) => r.requestedBy === actor && r.target === 'plugin')).toHaveLength(
      0,
    );

    // Süzgeçli: aynı veri, aynı pencere — yayın işi GÖRÜNÜR.
    const filtered = await svc.list(50, ['plugin']);
    expect(filtered.filter((r) => r.requestedBy === actor)).toHaveLength(1);
    expect(filtered.every((r) => r.target === 'plugin')).toBe(true);

    // Çoklu hedef (panel dağıtım ekranı deseni) + limit kırpması dürüst çalışır.
    const multi = await svc.list(5, ['plugin', 'backup']);
    expect(multi).toHaveLength(5);

    await db.execute(sql`DELETE FROM deployments WHERE requested_by = ${actor}`);
  });

  /**
   * FAIL-CLOSED: whitelist DIŞI hedef süzülür; hiçbiri geçerli değilse BOŞ liste döner —
   * sessizce "süzgeç yokmuş gibi hepsi" DÖNMEZ (`claimNext` ile aynı gerekçe: yanlış veriyi
   * doğru sanmak, hiç veri görmemekten kötüdür). `undefined` ise eski davranış korunur.
   */
  it('geçersiz hedef fail-closed: boş liste; süzgeçsiz çağrı eski davranışı korur', async () => {
    await db.execute(sql`
      INSERT INTO deployments (target, status, requested_by) VALUES ('api', 'success', ${actor})
    `);

    expect(await svc.list(50, ['uydurma-hedef'])).toHaveLength(0);
    expect(await svc.list(50, [])).toHaveLength(0);
    expect((await svc.list(50)).length).toBeGreaterThan(0);

    await db.execute(sql`DELETE FROM deployments WHERE requested_by = ${actor}`);
  });
});
