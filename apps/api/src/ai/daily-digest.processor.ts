import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SweepAlarmService } from '../maintenance/sweep-alarm.service';
import { DAILY_DIGEST_QUEUE, DailyDigestService } from './daily-digest.service';

/** Tekrarlı günlük özet + eşik alarm işini çalıştırır (§16). LowStockProcessor deseniyle aynı. */
@Processor(DAILY_DIGEST_QUEUE)
export class DailyDigestProcessor extends WorkerHost {
  constructor(
    private readonly digest: DailyDigestService,
    private readonly alarm: SweepAlarmService,
  ) {
    super();
  }

  async process(_job: Job): Promise<{ sent: boolean; alerts: number }> {
    return this.digest.run();
  }

  /**
   * İş patlarsa kritik alarm (dedupe'lu) + logger.error — sessiz ölüm bitti (§16).
   *
   * BURADA ÖZELLİKLE GEREKLİ: bu iş günde BİR kez koşar ve idempotent DEĞİLDİR. Patlarsa
   * o günün özeti VE tüm sabit-eşik kritik alarmları sessizce kaybolur — yani "alarm
   * gelmedi" ile "her şey yolunda" ayırt edilemez hâle gelir. Kardeş süpürmelerin
   * (expiry/retention/reconcile/low-stock) hepsinde bu handler vardı, yalnız bu iş
   * atlanmıştı (denetim bulgusu).
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error): Promise<void> {
    await this.alarm.report(DAILY_DIGEST_QUEUE, job?.name ?? 'digest', err);
  }
}
