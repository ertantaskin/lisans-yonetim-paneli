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
/**
 * Dış kopya KURULU DEĞİL uyarısı SÜREKLİ bir durumdur, olay değil — haftada bir hatırlatır.
 * (Kanca kurulu ama BAŞARISIZ olduğunda `BACKUP_ALERT_DEDUPE_HOURS` kullanılır: orada
 * operatör dış kopyanın alındığını SANIYOR, yani daha acil ve daha sık hatırlatılmalı.)
 */
const OFFSITE_SKIPPED_DEDUPE_HOURS = 7 * 24;

/** Bildirim tipleri — /notifications süzgeci ve dedupe anahtarı. */
export const BACKUP_STALE_TYPE = 'backup_stale';
export const DRILL_STALE_TYPE = 'drill_stale';
/**
 * Dış kopya alarmı İKİ AYRI TİP — çünkü dedupe YALNIZ tipe ve zamana bakar.
 *
 * ARIZA (tek tip kullanılırken): önce 'skipped' warning'i yazılır; operatör kancayı kurar
 * ama kanca BOZUKtur → durum 'failed'e (critical) yükselir; dedupe "son 24 saatte
 * backup_offsite var" deyip KRİTİK alarmı ÜRETMEZ. En tehlikeli durumun bildirimi, daha
 * zararsız olanı tarafından bastırılıyordu — üstelik tam da operatörün dış kopyanın
 * alındığını SANDIĞI anda. Tipleri ayırmak iki pencereyi de bağımsızlaştırır.
 *
 * İkisinin de `apps/admin/lib/labels.ts` sözlüğünde KARŞILIĞI VARDIR; eksik olsaydı
 * operatör bildirim listesinde ham `backup_offsite_failed` görürdü.
 */
export const OFFSITE_ALERT_TYPE = 'backup_offsite';
export const OFFSITE_FAILED_ALERT_TYPE = 'backup_offsite_failed';

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

    /*
     * DIŞ KOPYA (offsite) — alarm tasarımındaki kendi boşluğumuz.
     *
     * Yedek tazeliği ve tatbikat için alarm vardı; dış kopya için YOKTU. Sonuç: yedekler
     * düzenli alınır, tatbikat geçer, iki alarm da susar — ama her dump YALNIZ yedeklemenin
     * sebebi olan makinede durur. Sunucu kaybedilirse veri de MASTER_KEY de gider; "yedeğimiz
     * var" sanısı gerçek bir kurtarma imkânı OLMADAN sürer. Panelde `/deployments` ekranında
     * rozet olarak görünüyordu, ama rozet yalnız BAKANA yarar.
     *
     * İKİ DURUM AYRI CÜMLE, AYRI ŞİDDET (yapılacak iş farklı):
     *  • 'skipped' → kanca hiç kurulmamış: operatör bunu bilerek seçmiş OLABİLİR → `warning`,
     *    uzun dedupe (haftada bir hatırlatma; alarm yorgunluğu yaratmaz).
     *  • 'failed'  → kanca KURULU ama çalışmıyor: operatör dış kopyanın ALINDIĞINI SANIYOR.
     *    Yanlış güven, hiç güvenmemekten tehlikelidir → `critical`, kısa dedupe.
     * İki durum AYRI `type` taşır: dedupe yalnız tipe baktığı için ortak tipte, önce yazılan
     * warning sonraki critical'ı 24 saate kadar BASTIRIYORDU (şiddet yükselmesi kayboluyordu).
     *
     * Yalnız BAŞARILI son yedeğe bakılır: yedek zaten alınamıyorsa asıl sorun backupStale'dir
     * ve o alarm ayrıca çalışır (aynı arızayı iki başlıkla bildirmeyiz).
     */
    const offsite = s.lastBackupSuccess?.offsite ?? null;
    if (offsite === 'failed') {
      created += await this.alert(
        OFFSITE_FAILED_ALERT_TYPE,
        BACKUP_ALERT_DEDUPE_HOURS,
        'critical',
        'Dış kopya BAŞARISIZ (yedek yalnız bu sunucuda)',
        'Yedek alındı ama dış kopya komutu (BACKUP_OFFSITE_CMD) başarısız oldu — dump yalnız ' +
          'bu sunucuda duruyor. Sunucu kaybedilirse veri de MASTER_KEY de kurtarılamaz. ' +
          'Kanca çıktısını kontrol edin: docs/RUNBOOK-DR.md §4.4.',
        { offsite },
      );
    } else if (offsite === 'skipped') {
      created += await this.alert(
        OFFSITE_ALERT_TYPE,
        OFFSITE_SKIPPED_DEDUPE_HOURS,
        'warning',
        'Dış kopya kurulu değil (yedek yalnız bu sunucuda)',
        'Yedekler alınıyor ama BACKUP_OFFSITE_CMD tanımsız — dump yalnız bu sunucuda duruyor. ' +
          'Sunucu kaybedilirse yedek de birlikte gider. Hedef ve kimlik bilgisi sizde: ' +
          'docs/RUNBOOK-DR.md §4.4. MASTER_KEY yedeğin İÇİNDE DEĞİLDİR — ayrı kasada iki ' +
          'çevrimdışı kopya tutun.',
        { offsite },
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
