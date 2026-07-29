import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { makeDb, type Db } from './_helpers';
import { DeploymentsService } from '../../src/deployments/deployments.service';

/**
 * ENTEGRASYON — 'plugin' dağıtım hedefi + serbest not (0028). Gerçek PG.
 *
 * 'plugin' hedefi deploy.sh argümanı DEĞİLDİR: runner bu hedefte ayrı dallanıp repo
 * HEAD'inden WP eklenti zip'i üretir ve panele publish eder. Changelog metni `note`
 * kolonunda taşınır → runner claim yanıtından okur (bu testin doğruladığı sözleşme).
 *
 * deployments tablosunun tag kolonu yok → kendi requested_by damgamızla temizleriz.
 * request() guard'ı GLOBAL aktif (pending/running) kontrolü yaptığından beforeAll'da
 * zombi aktif kayıtları temizler, her test de kendi kaydını finish ile kapatır
 * (aksi hâlde sonraki test sahte 409 alır — deployments.service.test.ts deseni).
 */
describe('DeploymentsService — plugin hedefi + note (integration)', () => {
  let db: Db;
  let end: () => Promise<void>;
  let svc: DeploymentsService;
  const actor = 'it-deploy-plugin-test';

  /** Testin bıraktığı aktif kaydı kapatır (bir sonraki test kilide takılmasın). */
  async function closeActive(id: string): Promise<void> {
    await svc.claimNext();
    await svc.finish(id, 'success', {});
  }

  beforeAll(async () => {
    ({ db, end } = makeDb());
    svc = new DeploymentsService(db as never);
    await db.execute(sql`DELETE FROM deployments WHERE status IN ('pending','running')`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM deployments WHERE requested_by = ${actor}`);
    await end();
  });

  it("'plugin' hedefi kabul edilir; note kaydedilir ve claim yanıtında runner'a döner", async () => {
    const changelog = 'v0.9.2 — eşleme kutusu düzeltmesi\n- bekleyen satır tanısı';
    const d = await svc.request('plugin', actor, changelog);

    expect(d.target).toBe('plugin');
    expect(d.status).toBe('pending');
    expect(d.note).toBe(changelog);

    // Runner claim yanıtından hem target (hangi dala gidecek) hem note'u (changelog) okur.
    const claimed = await svc.claimNext();
    expect(claimed?.id).toBe(d.id);
    expect(claimed?.target).toBe('plugin');
    expect(claimed?.note).toBe(changelog);

    await svc.finish(d.id, 'success', { gitSha: 'plug1234' });
  });

  it('geçersiz hedef 400 (BadRequestException) — whitelist dışı değer kaydedilmez', async () => {
    // Yakın-isabet varyantlar da reddedilmeli (whitelist tam eşleşme, enjeksiyon yok).
    await expect(svc.request('eklenti', actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.request('plugin admin', actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.request('PLUGIN', actor)).rejects.toBeInstanceOf(BadRequestException);

    // Hiçbiri satır yazmamalı (guard INSERT'ten ÖNCE çalışır) → whitelist dışı target yok.
    const rows = await db.execute(sql`
      SELECT count(*)::int AS c FROM deployments
      WHERE requested_by = ${actor} AND target NOT IN ('api','admin','api admin','plugin')
    `);
    expect((rows[0] as { c: number }).c).toBe(0);
  });

  it('aktif dağıtım varken ikinci istek 409 (plugin hedefi de aynı tek-aktif kilidine tabi)', async () => {
    const d = await svc.request('plugin', actor, 'ilk');
    // Farklı hedef olsa bile aynı anda tek aktif dağıtım → 409.
    await expect(svc.request('api', actor)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.request('plugin', actor, 'ikinci')).rejects.toBeInstanceOf(ConflictException);

    await closeActive(d.id);

    // Kilit açıldı → yeni plugin isteği yeniden kabul edilir.
    const d2 = await svc.request('plugin', actor, 'sonraki');
    expect(d2.status).toBe('pending');
    await closeActive(d2.id);
  });

  it('note 2000 karakterde kırpılır; boş/whitespace ve verilmeyen note null olur', async () => {
    const long = 'x'.repeat(2500);
    const d1 = await svc.request('plugin', actor, long);
    expect(d1.note).toHaveLength(2000);
    expect(d1.note).toBe('x'.repeat(2000));
    await closeActive(d1.id);

    // Yalnız boşluktan ibaret not "dolu" sayılmaz → null (UI'da boş changelog satırı çıkmaz).
    const d2 = await svc.request('plugin', actor, '   \n  ');
    expect(d2.note).toBeNull();
    await closeActive(d2.id);

    // note verilmeyen hedefler (api/admin) etkilenmez — geriye dönük uyumlu.
    const d3 = await svc.request('api admin', actor);
    expect(d3.note).toBeNull();
    await closeActive(d3.id);
  });
});
