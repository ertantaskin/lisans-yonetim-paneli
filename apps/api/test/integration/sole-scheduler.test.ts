import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertJobSchedulers, upsertSoleJobScheduler } from '../../src/queue/sole-scheduler';

/**
 * ENTEGRASYON — "bu kuyrukta tam olarak BİR zamanlayıcı" sözleşmesi (gerçek Redis).
 *
 * NEDEN VAR: prod'da ÖLÇÜLDÜ ki dört süpürme kuyruğunun İKİŞER aktif tekrarlı zamanlayıcısı
 * vardı — biri kararlı kimlikli (`upsertJobScheduler`), diğeri eski `queue.add(…, { repeat })`
 * çağrısından kalan hash anahtarlı YETİM. Redis dağıtımlar arasında kalıcı olduğu için kod
 * düzeltilse bile eski kayıtlar silinmiyordu; `daily-digest` aynı dakikada iki kez koşuyor,
 * yani günlük özet ve kritik alarm ÇİFT gidiyordu. Bu test o senaryoyu birebir kurar.
 *
 * Kuyruk adı her koşuda benzersiz → paralel koşumlar ve gerçek kuyruklar etkilenmez.
 */
describe('upsertSoleJobScheduler — yetim tekrarlı zamanlayıcı temizliği', () => {
  const queueName = `it-sole-${randomUUID().slice(0, 8)}`;
  let connection: IORedis;
  let queue: Queue;
  const logger = new Logger('sole-scheduler.test');

  beforeAll(() => {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL tanımlı değil — bu test gerçek Redis gerektirir.');
    connection = new IORedis(url, { maxRetriesPerRequest: null });
    queue = new Queue(queueName, { connection });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await connection.quit();
  });

  it('eski queue.add(repeat) kaydını siler, kararlı kimlikli olanı BIRAKIR', async () => {
    // 1) ESKİ desen: hash anahtarlı tekrarlı iş (kimliği içerikten türetilir).
    await queue.add('sweep', {}, { repeat: { every: 60_000 } });
    expect(await queue.getJobSchedulers(0, 99)).toHaveLength(1);

    // 2) YENİ desen doğrudan çağrılsaydı İKİ zamanlayıcı yan yana kalırdı (prod'daki durum).
    //    Yardımcı ise upsert'ten sonra yetimi siler.
    await upsertSoleJobScheduler(
      queue,
      'sweep-v2',
      { every: 60_000 },
      { name: 'sweep', data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } },
      logger,
    );

    const after = await queue.getJobSchedulers(0, 99);
    expect(after).toHaveLength(1);
    expect(after[0]!.key).toBe('sweep-v2');
  });

  it('tekrar çağrılınca kendi kaydını SİLMEZ (idempotent — boot her açılışta koşar)', async () => {
    await upsertSoleJobScheduler(
      queue,
      'sweep-v2',
      { every: 60_000 },
      { name: 'sweep', data: {}, opts: {} },
      logger,
    );
    await upsertSoleJobScheduler(
      queue,
      'sweep-v2',
      { every: 60_000 },
      { name: 'sweep', data: {}, opts: {} },
      logger,
    );

    const after = await queue.getJobSchedulers(0, 99);
    expect(after).toHaveLength(1);
    expect(after[0]!.key).toBe('sweep-v2');
  });

  it('kimlik YENİDEN ADLANDIRILIRSA eskisi temizlenir (ileriye dönük self-heal)', async () => {
    await upsertSoleJobScheduler(
      queue,
      'sweep-v3',
      { every: 120_000 },
      { name: 'sweep', data: {}, opts: {} },
      logger,
    );

    const after = await queue.getJobSchedulers(0, 99);
    expect(after).toHaveLength(1);
    expect(after[0]!.key).toBe('sweep-v3');
    // Periyot da gerçekten güncellendi (upsert çalıştı, yalnız temizlik değil).
    // `every` sürücü sürümüne göre sayı ya da dize dönebilir → değere göre karşılaştır.
    expect(Number(after[0]!.every)).toBe(120_000);
  });
});

/**
 * ENTEGRASYON — ÇOKLU beklenen zamanlayıcı (gerçek Redis).
 *
 * NEDEN VAR: mutabakat kuyruğuna 15 dakikalık SICAK süpürmenin yanına HAFTALIK TAM koşu
 * eklendi. Tekil yardımcıyla bu SESSİZCE İMKÂNSIZDI — her çağrı diğerinin kaydını "yetim"
 * sayıp siler, boot sırasına göre biri hep kaybolurdu ve geriye yalnız bir `warn` kalırdı
 * (yani "haftalık tam mutabakat var" sanılır, hiç koşmazdı). Bu testler sözleşmeyi ÇALIŞMA
 * ANINDA zorlar: kardeşler birbirini silmez, kümenin dışındakiler yine silinir.
 */
describe('upsertJobSchedulers — çoklu beklenen zamanlayıcı', () => {
  const queueName = `it-multi-${randomUUID().slice(0, 8)}`;
  let connection: IORedis;
  let queue: Queue;
  const logger = new Logger('sole-scheduler.multi.test');

  const specs = [
    {
      id: 'reconcile-sweep',
      repeat: { every: 900_000 },
      template: { name: 'sweep', data: {}, opts: {} },
    },
    {
      id: 'reconcile-full',
      repeat: { pattern: '15 4 * * 0' },
      template: { name: 'full-sweep', data: {}, opts: {} },
    },
  ];

  beforeAll(() => {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL tanımlı değil — bu test gerçek Redis gerektirir.');
    connection = new IORedis(url, { maxRetriesPerRequest: null });
    queue = new Queue(queueName, { connection });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await connection.quit();
  });

  it('İKİ kardeş zamanlayıcı yan yana yaşar (biri diğerini silmez)', async () => {
    await upsertJobSchedulers(queue, specs, logger);

    const after = await queue.getJobSchedulers(0, 99);
    expect(after.map((s) => s.key).sort()).toEqual(['reconcile-full', 'reconcile-sweep']);
  });

  it('boot tekrarında ikisi de KALIR (idempotent)', async () => {
    await upsertJobSchedulers(queue, specs, logger);
    await upsertJobSchedulers(queue, specs, logger);

    const after = await queue.getJobSchedulers(0, 99);
    expect(after.map((s) => s.key).sort()).toEqual(['reconcile-full', 'reconcile-sweep']);
  });

  it('kümenin DIŞINDAKİ yetim yine silinir (temizlik kuralı korunur)', async () => {
    // Eski hash anahtarlı kayıt (eski queue.add(repeat) deseni) — kümede yok → yetim.
    await queue.add('sweep', { legacy: true }, { repeat: { every: 61_000 } });
    expect((await queue.getJobSchedulers(0, 99)).length).toBe(3);

    await upsertJobSchedulers(queue, specs, logger);

    const after = await queue.getJobSchedulers(0, 99);
    expect(after.map((s) => s.key).sort()).toEqual(['reconcile-full', 'reconcile-sweep']);
  });

  it('TEK çağrıda verilmezse ikinci çağrı birincinin kaydını siler (sözleşmenin sınırı)', async () => {
    // Bu, yardımcının BELGELENMİŞ sınırıdır — "hepsi tek çağrıda" kuralının NEDENİ.
    // Kontrol denemesi niteliğinde: kural yazılı olmasa bu davranış sessiz bir arıza olurdu.
    await upsertJobSchedulers(queue, [specs[0]!], logger);
    await upsertJobSchedulers(queue, [specs[1]!], logger);

    const after = await queue.getJobSchedulers(0, 99);
    expect(after.map((s) => s.key)).toEqual(['reconcile-full']);
  });
});
