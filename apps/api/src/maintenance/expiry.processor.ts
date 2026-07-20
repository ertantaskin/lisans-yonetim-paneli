import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { EXPIRY_QUEUE, ExpiryService } from './expiry.service';

/** Tekrarlı süre-bitişi taramasını çalıştırır (§11). */
@Processor(EXPIRY_QUEUE)
export class ExpiryProcessor extends WorkerHost {
  constructor(private readonly expiry: ExpiryService) {
    super();
  }

  async process(_job: Job): Promise<{ expired: number }> {
    const expired = await this.expiry.sweepExpired();
    return { expired };
  }
}
