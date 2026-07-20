import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SECURITY_QUEUE, SecurityService } from './security.service';

/** Tekrarlı güvenlik/anomali taramasını çalıştırır (§5/§15). ExpiryProcessor deseniyle aynı. */
@Processor(SECURITY_QUEUE)
export class SecurityProcessor extends WorkerHost {
  constructor(private readonly security: SecurityService) {
    super();
  }

  async process(_job: Job): Promise<{ created: number }> {
    return this.security.scan();
  }
}
