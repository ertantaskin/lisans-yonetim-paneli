import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SweepAlarmService } from '../maintenance/sweep-alarm.service';
import { SITE_SILENCE_QUEUE, SiteSilenceService } from './site-silence.service';

/** Tekrarlı mağaza sessizlik taramasını çalıştırır (§16). LowStockProcessor deseniyle aynı. */
@Processor(SITE_SILENCE_QUEUE)
export class SiteSilenceProcessor extends WorkerHost {
  constructor(
    private readonly silence: SiteSilenceService,
    private readonly alarm: SweepAlarmService,
  ) {
    super();
  }

  async process(_job: Job): Promise<{ created: number }> {
    const created = await this.silence.checkSilence();
    return { created };
  }

  /**
   * İş patlarsa kritik alarm (dedupe'lu) + logger.error — expiry/reconcile/retention/low-stock
   * ile aynı desen (§16 "sessiz iş ölümü yok"). Bu projede İKİ tekrarlı iş tam da bu handler
   * eksik olduğu için sessizce ölmüştü.
   *
   * BURADA EKSTRA KRİTİK: bu taramanın TEK işi "sessizliği fark etmek". Kendisi sessizce
   * ölürse ortaya iki katmanlı bir körlük çıkar — mağaza susar, alarm da susar, panel yine
   * "sağlıklı" görünür (tam olarak bu özelliğin var olma sebebi olan senaryo).
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error): Promise<void> {
    await this.alarm.report(SITE_SILENCE_QUEUE, job?.name ?? 'sweep', err);
  }
}
