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
});
