import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { EXPIRY_QUEUE, ExpiryService } from './expiry.service';
import { SweepAlarmService } from './sweep-alarm.service';

/** Tekrarlı süre-bitişi taramasını çalıştırır (§11). */
@Processor(EXPIRY_QUEUE)
export class ExpiryProcessor extends WorkerHost {
  constructor(
    private readonly expiry: ExpiryService,
    private readonly alarm: SweepAlarmService,
  ) {
    super();
  }

  async process(_job: Job): Promise<{ expired: number }> {
    const expired = await this.expiry.sweepExpired();
    return { expired };
  }

  /** İş patlarsa kritik alarm (dedupe'lu) + logger.error — sessiz ölüm bitti (§16). */
  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error): Promise<void> {
    await this.alarm.report(EXPIRY_QUEUE, job?.name ?? 'sweep', err);
  }
}
