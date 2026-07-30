import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Bakım işi (sweep) başarısızlık alarmı dedupe penceresi (saat). Env: SWEEP_ALARM_DEDUPE_HOURS.
 * expiry 5dk'da, reconcile 15dk'da çalışır → kalıcı bir arıza dedupe olmadan yüzlerce özdeş
 * kritik Telegram alarmı/gün üretir (alarm körlüğü). Pencere içinde AYNI kuyruk için tek alarm.
 * logger.error dedupe'a TABİ DEĞİL (her başarısızlıkta çalışır → gözlemlenebilirlik korunur).
 */
function dedupeHours(): number {
  const v = process.env.SWEEP_ALARM_DEDUPE_HOURS;
  if (v === undefined || v.trim() === '') return 6;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

/**
 * Bakım işi (BullMQ sweep) başarısızlık alarmı (§16). expiry/reconcile/retention işleri
 * `@OnWorkerEvent('failed')` ile buraya düşer: iş patlarsa SESSİZCE ölmez —
 * NotificationsService.create ile kritik bildirim (env-gated Telegram) üretilir + logger.error.
 *
 * Reconcile'ın mevcut ihlal-alarmı deseniyle aynı: best-effort (bildirim hatası sweep'i KESMEZ),
 * dedupe'lu (kuyruk başına pencere), sır/PII taşımaz (yalnız kuyruk adı + hata mesajı özeti).
 */
@Injectable()
export class SweepAlarmService {
  private readonly logger = new Logger(SweepAlarmService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Başarısız sweep işini kritik bildirime çevirir. Her zaman logger.error basar; kritik
   * bildirim/Telegram push dedupe penceresine tabidir (aynı kuyruk için pencerede tek alarm).
   *
   * GİZLİLİK: mesaj yalnız kuyruk adı + iş adı + hata mesajı özeti içerir. Sweep hataları
   * DB/altyapı kaynaklıdır (sır taşımaz) ama yine de mesaj 500 karaktere kırpılır (savunma).
   *
   * @param queue  Kuyruk adı (ör. 'expiry' | 'reconcile' | 'retention') — dedupe anahtarı.
   * @param jobName BullMQ iş adı (ör. 'sweep') — bağlam.
   * @param error  Yakalanan hata.
   */
  async report(queue: string, jobName: string, error: unknown): Promise<void> {
    const msg = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    // logger.error dedupe'suz — her başarısızlıkta çalışır (kimse Telegram tail'lemese bile iz kalır).
    this.logger.error(`Bakım işi başarısız [${queue}/${jobName}]: ${msg}`);

    const hours = dedupeHours();
    try {
      // Dedupe: son `hours` saatte AYNI kuyruk için 'sweep_failed' bildirimi varsa Telegram spam'ini önle.
      const recent = await rawRows<{ exists: boolean }>(this.db, sql`
        SELECT EXISTS (
          SELECT 1 FROM notifications
          WHERE type = 'sweep_failed'
            AND created_at > now() - (${hours} * interval '1 hour')
            AND meta->>'queue' = ${queue}
        ) AS exists;
      `);
      if (recent[0]?.exists) {
        this.logger.warn(
          `Sweep başarısızlık alarmı dedupe: son ${hours} saatte '${queue}' için zaten bildirildi — ` +
            `kritik bildirim/Telegram atlandı (logger.error her başarısızlıkta sürüyor).`,
        );
        return;
      }

      await this.notifications.create({
        type: 'sweep_failed',
        severity: 'critical',
        title: 'Bakım işi başarısız (sweep)',
        message:
          `'${queue}' bakım işi (${jobName}) başarısız oldu — elle inceleme gerekli. Hata: ${msg}`,
        // meta yalnız DB'de (Telegram gövdesine gitmez) → dedupe anahtarı + kök-neden bağlamı.
        meta: { queue, jobName, error: msg },
      });
    } catch (err) {
      // Bildirim/DB hatası sweep'i KESMEZ — zaten logger.error ile iz bırakıldı.
      this.logger.warn(
        `Sweep başarısızlık bildirimi üretilemedi (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
