import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DAILY_DIGEST_QUEUE, DailyDigestService } from './daily-digest.service';

/** Tekrarlı günlük özet + eşik alarm işini çalıştırır (§16). LowStockProcessor deseniyle aynı. */
@Processor(DAILY_DIGEST_QUEUE)
export class DailyDigestProcessor extends WorkerHost {
  constructor(private readonly digest: DailyDigestService) {
    super();
  }

  async process(_job: Job): Promise<{ sent: boolean; alerts: number }> {
    return this.digest.run();
  }
}
