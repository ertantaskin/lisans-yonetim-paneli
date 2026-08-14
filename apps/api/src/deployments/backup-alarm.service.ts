import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { NotificationsService } from '../notifications/notifications.service';
import { upsertSoleJobScheduler } from '../queue/sole-scheduler';
import { DeploymentsService } from './deployments.service';

export const BACKUP_ALARM_QUEUE = 'backup-alarm';

/**
 * Tazelik taraması periyodu (ms). Eşikler SAAT (yedek 26s) ve GÜN (tatbikat 35g) mertebesinde
 * olduğu için 6 saatlik granülerlik fazlasıyla yeterli: gecelik yedek atlanırsa alarm en geç
 * ertesi gün öğlene kadar düşer. Daha sık koşmak alarmı hızlandırmaz, yalnız DB yükü ekler.
 */
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Alarm dedupe pencereleri (saat). Yedek bayatlığı KALICI bir durumdur (yedek alınana kadar
 * her turda yeniden tespit edilir) → pencere olmadan 6 saatte bir özdeş kritik Telegram
 * üretilirdi (alarm körlüğü). SweepAlarmService'in dedupe deseniyle aynı; farkı, pencerelerin
 * eşiklerin mertebesine göre seçilmiş olması.
 */
const BACKUP_ALERT_DEDUPE_HOURS = 24;
const DRILL_ALERT_DEDUPE_HOURS = 7 * 24;

/** Bildirim tipleri — /notifications süzgeci ve dedupe anahtarı. */
export const BACKUP_STALE_TYPE = 'backup_stale';
export const DRILL_STALE_TYPE = 'drill_stale';

/**
 * YEDEK TAZELİK ALARMI (§16 DR) — "yedek yolu sessizce ölebilir" bulgusunun kapatılması.
 *
 * NEDEN VAR (denetim O1): `backupSummary()` doğru hesaplıyordu ama SONUCUNU yalnız
 * `/deployments` EKRANI okuyordu. Sistemin diğer tüm kritik durumları (sweep başarısızlığı,
 * reconcile ihlali, mail yapılandırma hatası, mağaza sessizliği) `notifications` + env-gated
 * Telegram'a düşerken DR düşmüyordu. Sonuç: cron kurulmamış / ADMIN_TOKEN bozulmuş / runner
 * betiği silinmiş olsa AYLARCA hiç yedek alınmaz, hiçbir kanal ses çıkarmaz ve tek işaret
 * operatörün açmayabileceği bir sayfadaki bant olurdu. Yedeğin yokluğu, tam da fark edilmesi
 * en geç olan arıza sınıfıdır — çünkü ancak ihtiyaç duyulduğu gün anlaşılır.
 *
 * TASARIM: yeni tablo/migration YOK; mevcut `deployments` kayıtlarından türetilen özet okunur
 * ve mevcut bildirim kanalına yazılır. Alarm YALNIZ RAPOR EDER, hiçbir şeyi kendiliğinden
 * çalıştırmaz (§15 "AI/sistem önerir, insan onaylar" çizgisi): panelden yedek tetiklemek
 * owner'ın kararıdır ve zaten tek-aktif-iş kilidine tabidir.
 */
@Injectable()
export class BackupAlarmService implements OnModuleInit {
  private readonly logger = new Logger(BackupAlarmService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(BACKUP_ALARM_QUEUE) private readonly queue: Queue,
    private readonly deployments: DeploymentsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Boot'ta tekrarlı taramayı KARARLI kimlikle upsert eder (diğer 6 sweep ile aynı desen). */
  async onModuleInit(): Promise<void> {
    await upsertSoleJobScheduler(
      this.queue,
      'backup-alarm-sweep',
      { every: SWEEP_EVERY_MS },
      { name: 'sweep', data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } },
      this.logger,
    );
  }

  /**
   * Yedek/tatbikat tazeliğini denetler; bayatsa dedupe'lu bildirim üretir.
   * @returns üretilen bildirim sayısı (0 = her şey taze ya da pencere içinde zaten bildirildi)
   */
  async checkFreshness(): Promise<{ created: number }> {
    const s = await this.deployments.backupSummary();
    let created = 0;

    if (s.backupStale) {
      // Yedeğin HİÇ olmaması, eskisinden daha kötüdür → iki durum ayrı cümleyle anlatılır,
      // çünkü operatörün yapacağı iş farklı ("cron hiç kurulmamış" vs "gecelik yedek düştü").
      const age =
        s.backupAgeHours === null
          ? 'HİÇ başarılı yedek kaydı yok'
          : `son başarılı yedek ${s.backupAgeHours} saat önce`;
      const attempt = s.lastBackupAttempt;
      const attemptNote =
        attempt && attempt.status === 'failed'
          ? ` Son deneme BAŞARISIZ: ${(attempt.error ?? '—').slice(0, 200)}`
          : attempt
            ? ''
            : ' Kuyrukta hiç yedek İSTEĞİ de yok — cron (backup-runner.sh --nightly) kurulmamış olabilir.';
      created += await this.alert(
        BACKUP_STALE_TYPE,
        BACKUP_ALERT_DEDUPE_HOURS,
        'critical',
        'Yedek bayat (DR riski)',
        `Gecelik yedek alınmıyor: ${age} (eşik ${s.thresholds.backupMaxAgeHours} saat).${attemptNote} ` +
          'Kurulum ve teşhis: docs/RUNBOOK-DR.md §4.3.',
        {
          backupAgeHours: s.backupAgeHours,
          thresholdHours: s.thresholds.backupMaxAgeHours,
          lastAttemptStatus: attempt?.status ?? null,
        },
      );
    }

    if (s.drillStale) {
      // Tatbikat 'warning': yedek ALINIYOR ama geri-yüklenebilirliği kanıtlanmamış. Yedeğin
      // hiç alınmamasından daha az acildir, yine de sessiz kalmamalı (doğrulanmamış yedek,
      // ihtiyaç anına kadar yedek SANILIR).
      const age =
        s.drillAgeDays === null
          ? 'HİÇ başarılı tatbikat kaydı yok'
          : `son başarılı tatbikat ${s.drillAgeDays} gün önce`;
      created += await this.alert(
        DRILL_STALE_TYPE,
        DRILL_ALERT_DEDUPE_HOURS,
        'warning',
        'Yedek tatbikatı bayat (geri yükleme doğrulanmamış)',
        `Geri-yükleme tatbikatı yapılmıyor: ${age} (eşik ${s.thresholds.drillMaxAgeDays} gün). ` +
          "Doğrulanmamış yedek, ihtiyaç anına kadar 'yedek' sanılır. Panelden 'backup-drill' " +
          'tetikleyin — docs/RUNBOOK-DR.md §6.',
        { drillAgeDays: s.drillAgeDays, thresholdDays: s.thresholds.drillMaxAgeDays },
      );
    }

    if (created === 0) {
      this.logger.debug(
        `Yedek tazelik taraması: backupStale=${s.backupStale} drillStale=${s.drillStale} (yeni bildirim yok)`,
      );
    }
    return { created };
  }

  /**
   * Dedupe'lu bildirim üretimi. `logger.warn` dedupe'a TABİ DEĞİL (pencere içinde bile her
   * turda iz kalır) — SweepAlarmService'in "Telegram sussa da log konuşur" kuralı.
   */
  private async alert(
    type: string,
    dedupeHours: number,
    severity: 'warning' | 'critical',
    title: string,
    message: string,
    meta: Record<string, unknown>,
  ): Promise<number> {
    this.logger.warn(`${title}: ${message}`);
    try {
      const recent = await rawRows<{ exists: boolean }>(this.db, sql`
        SELECT EXISTS (
          SELECT 1 FROM notifications
          WHERE type = ${type}
            AND created_at > now() - (${dedupeHours} * interval '1 hour')
        ) AS exists;
      `);
      if (recent[0]?.exists) return 0;

      await this.notifications.create({ type, severity, title, message, meta });
      return 1;
    } catch (err) {
      // Bildirim/DB hatası taramayı KESMEZ (logger.warn ile iz zaten bırakıldı). İş
      // patlarsa BackupAlarmProcessor'ın 'failed' handler'ı ayrıca kritik alarm üretir.
      this.logger.warn(
        `Yedek tazelik bildirimi üretilemedi (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }
}
