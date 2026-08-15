import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { makeDb, type Db } from './_helpers';
import {
  BACKUP_MAX_AGE_HOURS,
  BACKUP_RUNNER_TARGETS,
  DEPLOY_RUNNER_TARGETS,
  DRILL_MAX_AGE_DAYS,
  DeploymentsService,
  parseBackupMeta,
} from '../../src/deployments/deployments.service';
import { DeploymentsController } from '../../src/deployments/deployments.controller';
import { OwnerGuard } from '../../src/auth/owner.guard';
import { BackupAlarmService, OFFSITE_ALERT_TYPE } from '../../src/deployments/backup-alarm.service';

/**
 * ENTEGRASYON — 'backup' / 'backup-drill' hedefleri (§16 DR). Gerçek PG.
 *
 * Yedek alma panelden TETİKLENİR ama panel konteynerinde ÇALIŞMAZ: kuyruğa bir istek yazılır,
 * host'taki `scripts/backup-runner.sh` claim eder, `backup-drill.sh`'ı koşar ve sonucu geri
 * yazar. Bu dosya o SÖZLEŞMEYİ kilitler:
 *   1) istek → claim → finish akışı yeni hedeflerde de çalışır (migration YOK; target TEXT),
 *   2) "aynı anda tek aktif iş" guard'ı yeni hedefleri de kapsar (ayrı yol açılmadı),
 *   3) runner hedef FİLTRESİ: yedek runner'ı dağıtım isteğini, dağıtım runner'ı yedek
 *      isteğini ASLA claim etmez (claim geri alınamaz → yanlış claim işi kaybettirir),
 *   4) zombi 'running' temizliği yeni hedeflerde de kilidi açar,
 *   5) owner-only kapısı (API'de OwnerGuard) yürürlükte,
 *   6) özet (son yedek / son tatbikat) log'daki panel işaretlerinden doğru türetilir ve
 *      eşik aşılınca 'stale' bayrağı yanar.
 *
 * deployments tablosunun tag kolonu yok → kendi requested_by damgamızla temizleriz.
 * request() guard'ı GLOBAL olduğundan beforeAll'da aktif kayıtlar temizlenir ve her test
 * kendi kaydını kapatır (deployments.service.test.ts deseni).
 */
describe('DeploymentsService — yedek hedefleri (integration)', () => {
  let db: Db;
  let end: () => Promise<void>;
  let svc: DeploymentsService;
  const actor = 'it-backup-target-test';

  /** Testin bıraktığı aktif kaydı kapatır (sonraki test sahte 409 almasın). */
  async function closeActive(id: string): Promise<void> {
    await svc.claimNext();
    await svc.finish(id, 'success', {});
  }

  /** Doğrudan SQL ile tamamlanmış bir yedek kaydı üretir (yaş/eşik senaryoları için). */
  async function seedFinished(opts: {
    target: string;
    status: 'success' | 'failed';
    agoMinutes: number;
    durationSecs?: number;
    log?: string;
  }): Promise<void> {
    // make_interval(secs => …): parametre TİPİ belirsiz kalmaz (`$1 || ' minutes'` biçimi
    // bind parametresiyle "operator is not unique" riski taşır).
    const startSecs = opts.agoMinutes * 60;
    const finishSecs = startSecs - (opts.durationSecs ?? 0);
    await db.execute(sql`
      INSERT INTO deployments (target, status, requested_by, created_at, started_at, finished_at, log)
      VALUES (
        ${opts.target}, ${opts.status}, ${actor},
        now() - make_interval(secs => ${startSecs}),
        now() - make_interval(secs => ${startSecs}),
        now() - make_interval(secs => ${finishSecs}),
        ${opts.log ?? null}
      )
    `);
  }

  /** Belirtilen süredir 'running' takılı bir kayıt üretir (zombi eşiği senaryoları). */
  async function seedRunning(target: string, agoMinutes: number): Promise<string> {
    const secs = agoMinutes * 60;
    const ins = await db.execute(sql`
      INSERT INTO deployments (target, status, requested_by, started_at, created_at)
      VALUES (${target}, 'running', ${actor},
              now() - make_interval(secs => ${secs}), now() - make_interval(secs => ${secs}))
      RETURNING id
    `);
    return (ins[0] as { id: string }).id;
  }

  async function statusOf(id: string): Promise<string> {
    const rows = await db.execute(sql`SELECT status FROM deployments WHERE id = ${id}`);
    return (rows[0] as { status: string }).status;
  }

  beforeAll(async () => {
    ({ db, end } = makeDb());
    svc = new DeploymentsService(db as never);
    await db.execute(sql`DELETE FROM deployments WHERE status IN ('pending','running')`);
    // Başka dosyaların bıraktığı yedek kayıtları özet testlerini kirletmesin.
    await db.execute(sql`DELETE FROM deployments WHERE target IN ('backup','backup-drill')`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM deployments WHERE requested_by = ${actor}`);
    await end();
  });

  it('şema değişmeden yeni hedefler kabul edilir: istek → claim → finish', async () => {
    const d = await svc.request('backup', actor, 'gecelik yedek');
    expect(d.target).toBe('backup');
    expect(d.status).toBe('pending');

    // Runner claim yanıtından target'ı okuyup BACKUP_ONLY moduna dallanır.
    const claimed = await svc.claimNext(BACKUP_RUNNER_TARGETS);
    expect(claimed?.id).toBe(d.id);
    expect(claimed?.target).toBe('backup');
    expect(claimed?.status).toBe('running');
    expect(claimed?.startedAt).toBeTruthy();

    const done = await svc.finish(d.id, 'success', {
      gitSha: 'bkp1234',
      log: [
        '[1/4] pg_dump',
        '── PANEL ÖZETİ ──',
        'BACKUP_FILE=/opt/backups/x.dump',
        'BACKUP_BYTES=2048',
        'BACKUP_OFFSITE=ok',
      ].join('\n'),
    });
    expect(done?.status).toBe('success');
    expect(done?.finishedAt).toBeTruthy();

    // 'backup-drill' de aynı sözleşmeyi izler.
    const d2 = await svc.request('backup-drill', actor);
    expect(d2.target).toBe('backup-drill');
    const claimed2 = await svc.claimNext(BACKUP_RUNNER_TARGETS);
    expect(claimed2?.id).toBe(d2.id);
    await svc.finish(d2.id, 'success', { log: 'BACKUP_RESTORE_SECS=7' });
  });

  it('geçersiz/yakın-isabet hedefler 400 — whitelist tam eşleşme', async () => {
    for (const bad of ['backups', 'backup drill', 'BACKUP', 'drill', 'backup-drill ']) {
      await expect(svc.request(bad, actor)).rejects.toBeInstanceOf(BadRequestException);
    }
    const rows = await db.execute(sql`
      SELECT count(*)::int AS c FROM deployments
      WHERE requested_by = ${actor}
        AND target NOT IN ('api','admin','api admin','plugin','backup','backup-drill')
    `);
    expect((rows[0] as { c: number }).c).toBe(0);
  });

  it('"aynı anda tek aktif iş" guard\'ı yedek hedeflerini de kapsar (ayrı kuyruk YOK)', async () => {
    const d = await svc.request('backup', actor);
    // Yedek çalışırken dağıtım da, ikinci bir yedek de reddedilir (deploy.sh servisi yeniden
    // başlatırsa dump yarıda kalır — bu yüzden kuyruk paylaşılıyor).
    await expect(svc.request('api admin', actor)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.request('backup', actor)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.request('backup-drill', actor)).rejects.toBeInstanceOf(ConflictException);

    await closeActive(d.id);

    // Tersi de doğru: dağıtım aktifken yedek isteği 409.
    const dep = await svc.request('api', actor);
    await expect(svc.request('backup', actor)).rejects.toBeInstanceOf(ConflictException);
    await closeActive(dep.id);
  });

  it("runner hedef filtresi: dağıtım runner'ı yedek işini, yedek runner'ı dağıtım işini claim ETMEZ", async () => {
    const b = await svc.request('backup', actor);

    // Dağıtım runner'ı kendi hedeflerini süzer → bekleyen yedek isteğine DOKUNMAZ.
    expect(await svc.claimNext(DEPLOY_RUNNER_TARGETS)).toBeNull();
    const stillPending = await db.execute(sql`SELECT status FROM deployments WHERE id = ${b.id}`);
    expect((stillPending[0] as { status: string }).status).toBe('pending');

    // Yedek runner'ı alır.
    const claimed = await svc.claimNext(BACKUP_RUNNER_TARGETS);
    expect(claimed?.id).toBe(b.id);
    await svc.finish(b.id, 'success', {});

    // Simetri: yedek runner'ı bir dağıtım isteğini claim etmez.
    const dep = await svc.request('api admin', actor);
    expect(await svc.claimNext(BACKUP_RUNNER_TARGETS)).toBeNull();
    const claimedDep = await svc.claimNext(DEPLOY_RUNNER_TARGETS);
    expect(claimedDep?.id).toBe(dep.id);
    await svc.finish(dep.id, 'success', {});

    // Filtre verilip hiçbiri geçerli değilse HİÇ iş alınmaz (yanlışlıkla "hepsi"ne düşmez).
    const b2 = await svc.request('backup', actor);
    expect(await svc.claimNext(['yedek', 'sunucu'])).toBeNull();
    // Argümansız çağrı ESKİ davranış: tüm hedefler (eski runner sürümü kırılmaz).
    const anyClaim = await svc.claimNext();
    expect(anyClaim?.id).toBe(b2.id);
    await svc.finish(b2.id, 'success', {});
  });

  it('takılı DAĞITIM işi 30dk sonra otomatik "failed" olur (self-heal, kilit açılır)', async () => {
    const stuckId = await seedRunning('api admin', 40);

    expect(await svc.claimNext(BACKUP_RUNNER_TARGETS)).toBeNull();
    expect(await statusOf(stuckId)).toBe('failed');

    // Zombi temizlendi → yeni yedek isteği yeniden kabul edilir.
    const d = await svc.request('backup', actor);
    expect(d.status).toBe('pending');
    await closeActive(d.id);
  });

  /**
   * O2 REGRESYONU — zombi zaman aşımı HEDEFE göre.
   *
   * Eskiden tek bir 30dk eşiği vardı: RTO hedefi 2 SAAT olan bir tatbikat 30. dakikada
   * "failed" damgalanıp tek-aktif-iş kilidini açıyordu; ardından `deploy.sh` tatbikatla
   * AYNI ANDA koşabiliyordu (docker build/up ⟷ pg_restore). Bu test o eşik ayrımını kilitler.
   */
  it('O2: uzun süren TATBİKAT 30dk-2sa arasında zombi sayılmaz; eşiği aşınca kapatılır', async () => {
    // 40 dakikadır koşan tatbikat MEŞRUDUR (eski davranışta burada öldürülüyordu).
    const drillId = await seedRunning('backup-drill', 40);
    expect(await svc.claimNext(BACKUP_RUNNER_TARGETS)).toBeNull();
    expect(await statusOf(drillId)).toBe('running');

    // 2 saati aşan ama 4 saatlik tatbikat eşiğinin altındaki koşum da MEŞRU kalır.
    await db.execute(sql`
      UPDATE deployments SET started_at = now() - interval '150 minutes' WHERE id = ${drillId}
    `);
    await svc.claimNext(BACKUP_RUNNER_TARGETS);
    expect(await statusOf(drillId)).toBe('running');

    // Kilit sonsuza kadar tutulmaz: eşiği (240dk) aşınca self-heal devreye girer.
    await db.execute(sql`
      UPDATE deployments SET started_at = now() - interval '5 hours' WHERE id = ${drillId}
    `);
    await svc.claimNext(BACKUP_RUNNER_TARGETS);
    expect(await statusOf(drillId)).toBe('failed');

    // 'backup' (yalnız dump) eşiği daha kısa: 40dk meşru, 3 saat zombi.
    const backupId = await seedRunning('backup', 40);
    await svc.claimNext(BACKUP_RUNNER_TARGETS);
    expect(await statusOf(backupId)).toBe('running');
    await db.execute(sql`
      UPDATE deployments SET started_at = now() - interval '3 hours' WHERE id = ${backupId}
    `);
    await svc.claimNext(BACKUP_RUNNER_TARGETS);
    expect(await statusOf(backupId)).toBe('failed');
  });

  /**
   * O2 REGRESYONU (ikinci yarısı) — `finish` CAS.
   *
   * Zombi temizliği bir işi 'failed' yaptıktan SONRA gerçek runner geç `finish success`
   * yazarsa satır ESKİDEN sessizce 'success'e dönüyordu: zaman aşımının, açılan kilidin ve
   * eşzamanlı koşmuş olabilecek dağıtımın hiçbir izi kalmıyordu. Artık sonuç EZİLMEZ ve
   * çakışma görünür biçimde işaretlenir.
   */
  it('O2: zombi olarak kapatılmış işin GEÇ finish\'i durumu EZMEZ, çakışma olarak işaretlenir', async () => {
    const id = await seedRunning('backup-drill', 60 * 6); // eşiğin (4sa) ötesi
    await svc.claimNext(BACKUP_RUNNER_TARGETS); // zombi temizliği burada koşar
    expect(await statusOf(id)).toBe('failed');

    const late = await svc.finish(id, 'success', {
      gitSha: 'late123',
      log: 'BACKUP_FILE=/opt/backups/late.dump\nBACKUP_BYTES=123',
    });

    // Durum KORUNUR (geç bildirim 'failed' → 'success' yapmaz).
    expect(late?.status).toBe('failed');
    expect(late?.error).toContain('GEÇ BİLDİRİM');
    // Zombi kapanışının kendi gerekçesi de silinmez (iki bilgi birlikte durur).
    expect(late?.error).toContain('Zaman aşımı');
    // Runner'ın logu kaybolmaz: satırda log yoktu → yazılır (kök-neden analizi bununla yapılır).
    expect(late?.log).toContain('BACKUP_FILE=/opt/backups/late.dump');
    expect(late?.gitSha).toBe('late123');

    // Bilinmeyen id → null (uydurma kayıt üretilmez).
    expect(
      await svc.finish('00000000-0000-0000-0000-000000000000', 'success', {}),
    ).toBeNull();
  });

  it('30dk takılı "pending" yedek isteği istek yolunda temizlenir (runner hiç koşmasa bile)', async () => {
    await db.execute(sql`
      INSERT INTO deployments (target, status, requested_by, created_at)
      VALUES ('backup', 'pending', ${actor}, now() - interval '45 minutes')
    `);
    // Runner (cron) kurulmamışsa istek sonsuza dek 'pending' kalır ve panelden bir daha
    // yedek alınamazdı; request() yolundaki temizlik bunu açar.
    const d = await svc.request('backup', actor);
    expect(d.status).toBe('pending');
    await closeActive(d.id);
  });

  it('owner-only kapısı: POST /deployments OwnerGuard ile korunur (yedek hedefleri dahil)', () => {
    // Yedek tetikleme AYRI bir uç değil — aynı POST ucu. Dolayısıyla owner kapısı da aynı.
    const guards = Reflect.getMetadata('__guards__', DeploymentsController.prototype.request) as
      unknown[] | undefined;
    expect(guards).toBeTruthy();
    expect(guards).toContain(OwnerGuard);
  });

  it('parseBackupMeta: panel işaretlerini log KUYRUĞUNDAN okur, bozuk değerleri yutar', () => {
    const meta = parseBackupMeta(
      [
        'BACKUP_BYTES=999999', // kırpılmış eski blok — SONUNCUSU kazanmalı
        '── PANEL ÖZETİ ──',
        'BACKUP_FILE=/opt/lisans/backups/lisanspanel_20260814-030000.dump',
        'BACKUP_BYTES=1048576',
        'BACKUP_OFFSITE=ok',
        'BACKUP_RESTORE_SECS=42',
      ].join('\n'),
    );
    expect(meta.file).toBe('/opt/lisans/backups/lisanspanel_20260814-030000.dump');
    expect(meta.sizeBytes).toBe(1048576);
    expect(meta.offsite).toBe('ok');
    expect(meta.restoreSecs).toBe(42);

    // Sayı olmayan / bilinmeyen değerler sessizce null (uydurma veri gösterilmez).
    const junk = parseBackupMeta('BACKUP_BYTES=abc\nBACKUP_OFFSITE=belki');
    expect(junk.sizeBytes).toBeNull();
    expect(junk.offsite).toBeNull();
    expect(parseBackupMeta(null).file).toBeNull();
  });

  it('özet: hiç yedek yokken "stale" yanar; taze yedek söndürür; bayat yedek yeniden yakar', async () => {
    await db.execute(sql`DELETE FROM deployments WHERE target IN ('backup','backup-drill')`);

    const empty = await svc.backupSummary();
    expect(empty.lastBackupSuccess).toBeNull();
    expect(empty.backupAgeHours).toBeNull();
    // Yedeğin HİÇ olmaması, eskisinden DAHA kötüdür → bayrak yanar.
    expect(empty.backupStale).toBe(true);
    expect(empty.drillStale).toBe(true);
    expect(empty.thresholds).toEqual({
      backupMaxAgeHours: BACKUP_MAX_AGE_HOURS,
      drillMaxAgeDays: DRILL_MAX_AGE_DAYS,
    });

    // 30 dk önce biten başarılı yedek → taze.
    await seedFinished({
      target: 'backup',
      status: 'success',
      agoMinutes: 30,
      durationSecs: 60,
      log: 'BACKUP_FILE=/opt/backups/a.dump\nBACKUP_BYTES=4096\nBACKUP_OFFSITE=skipped',
    });
    const fresh = await svc.backupSummary();
    expect(fresh.backupStale).toBe(false);
    expect(fresh.lastBackupSuccess?.sizeBytes).toBe(4096);
    expect(fresh.lastBackupSuccess?.offsite).toBe('skipped');
    expect(fresh.lastBackupSuccess?.durationSecs).toBe(60);
    // Tatbikat hâlâ yapılmadı → o bayrak yanmaya devam eder (iki eksen ayrı).
    expect(fresh.drillStale).toBe(true);

    // Yedek bayatlarsa (eşiğin ötesi) bayrak yeniden yanar.
    await db.execute(sql`DELETE FROM deployments WHERE target = 'backup'`);
    await seedFinished({
      target: 'backup',
      status: 'success',
      agoMinutes: (BACKUP_MAX_AGE_HOURS + 3) * 60,
    });
    const stale = await svc.backupSummary();
    expect(stale.backupStale).toBe(true);
    expect(stale.backupAgeHours).toBeGreaterThan(BACKUP_MAX_AGE_HOURS);
  });

  it('özet: başarılı TATBİKAT yedek yaşını da tazeler; başarısız deneme yaşı tazelemez', async () => {
    await db.execute(sql`DELETE FROM deployments WHERE target IN ('backup','backup-drill')`);

    // Tatbikat dump ALARAK başlar → "yedek yok" alarmını söndürmesi doğrudur.
    await seedFinished({
      target: 'backup-drill',
      status: 'success',
      agoMinutes: 60,
      log: 'BACKUP_RESTORE_SECS=12',
    });
    const s1 = await svc.backupSummary();
    expect(s1.backupStale).toBe(false);
    expect(s1.drillStale).toBe(false);
    expect(s1.lastDrillSuccess?.restoreSecs).toBe(12);

    // Sonrasında BAŞARISIZ bir yedek denemesi: yaş tazelenmemeli (başarısız yedek yedek değildir),
    // ama son deneme ekranda görünsün diye ayrıca döner.
    await seedFinished({ target: 'backup', status: 'failed', agoMinutes: 5 });
    const s2 = await svc.backupSummary();
    expect(s2.lastBackupSuccess).toBeNull();
    expect(s2.lastBackupAttempt?.status).toBe('failed');
    // Yaş hâlâ başarılı TATBİKAT'tan geliyor (≈60 dk), başarısız denemeden değil.
    expect(s2.backupAgeHours).toBeGreaterThan(0.5);
  });

  /**
   * DIŞ KOPYA ALARMI (§16 DR) — alarm tasarımındaki kendi boşluğumuzun kapatılması.
   *
   * Yedek tazeliği ve tatbikat için alarm VARDI, dış kopya için YOKTU: yedekler düzenli
   * alınır, tatbikat geçer, iki alarm da susar — ama her dump YALNIZ yedeklemenin sebebi
   * olan makinede durur. Durum panelde rozet olarak görünüyordu, ama rozet yalnız BAKANA
   * yarar. Bu test alarmın gerçekten ateşlediğini ve iki durumu FARKLI şiddetle bildirdiğini
   * kilitler; (c) şıkkı yanlış-pozitif üretmediğini kanıtlar.
   */
  it('dış kopya: kanca yoksa warning, kanca başarısızsa critical; başarılıysa alarm YOK', async () => {
    const seen: Array<{ type: string; severity: string }> = [];
    const notifications = {
      create: async (n: { type: string; severity: string }) => {
        seen.push({ type: n.type, severity: n.severity });
      },
    };
    // Kuyruk yalnız onModuleInit'te kullanılır (burada çağrılmaz) → güvenli stub.
    // Dedupe sorgusu GERÇEK DB'ye gider; bu yüzden her şıktan önce o tipteki kayıtlar silinir.
    const alarm = new BackupAlarmService(
      db as never,
      { add: async () => undefined } as never,
      svc,
      notifications as never,
    );

    /** Tek bir başarılı yedek kaydı bırakır (verilen offsite işaretiyle) ve alarmı koşturur. */
    async function runWith(offsite: string): Promise<void> {
      seen.length = 0;
      await db.execute(sql`DELETE FROM notifications WHERE type = ${OFFSITE_ALERT_TYPE}`);
      await db.execute(sql`DELETE FROM deployments WHERE target IN ('backup','backup-drill')`);
      await seedFinished({
        target: 'backup',
        status: 'success',
        agoMinutes: 30,
        log: `BACKUP_FILE=/opt/backups/a.dump\nBACKUP_OFFSITE=${offsite}`,
      });
      // Tatbikat kaydı YOK → drill_stale de yanar; süzgeç yalnız dış-kopya tipine bakar.
      await alarm.checkFreshness();
    }

    // (a) Kanca KURULU DEĞİL → 'warning' (operatör bunu bilerek seçmiş olabilir).
    await runWith('skipped');
    expect(seen.filter((n) => n.type === OFFSITE_ALERT_TYPE)).toEqual([
      { type: OFFSITE_ALERT_TYPE, severity: 'warning' },
    ]);

    // (b) Kanca KURULU ama BAŞARISIZ → 'critical': operatör dış kopyanın alındığını SANIYOR.
    //     Yanlış güven, hiç güvenmemekten tehlikelidir.
    await runWith('failed');
    expect(seen.filter((n) => n.type === OFFSITE_ALERT_TYPE)).toEqual([
      { type: OFFSITE_ALERT_TYPE, severity: 'critical' },
    ]);

    // (c) Dış kopya BAŞARILI → dış-kopya alarmı YOK (yanlış pozitif üretmez).
    await runWith('ok');
    expect(seen.filter((n) => n.type === OFFSITE_ALERT_TYPE)).toEqual([]);

    await db.execute(sql`DELETE FROM notifications WHERE type = ${OFFSITE_ALERT_TYPE}`);
  });
});
