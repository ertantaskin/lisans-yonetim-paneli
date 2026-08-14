import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SweepAlarmService } from '../maintenance/sweep-alarm.service';
import { BACKUP_ALARM_QUEUE, BackupAlarmService } from './backup-alarm.service';

/**
 * Tekrarlı yedek TAZELİK taramasını çalıştırır (§16 DR). SiteSilenceProcessor deseniyle aynı.
 *
 * "Alarmın alarmı" burada özellikle anlamlı: bu iş sessizce ölürse ortaya İKİ KATMANLI körlük
 * çıkar — yedek alınmaz VE bunu söyleyecek tarama da ölür; panel yine sağlıklı görünür.
 * Mağaza sessizlik taramasında aynı gerekçe yazılıydı, DR tarafında karşılığı yoktu.
 */
@Processor(BACKUP_ALARM_QUEUE)
export class BackupAlarmProcessor extends WorkerHost {
  constructor(
    private readonly backupAlarm: BackupAlarmService,
    private readonly alarm: SweepAlarmService,
  ) {
    super();
  }

  async process(_job: Job): Promise<{ created: number }> {
    return this.backupAlarm.checkFreshness();
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error): Promise<void> {
    await this.alarm.report(BACKUP_ALARM_QUEUE, job?.name ?? 'sweep', err);
  }
}
