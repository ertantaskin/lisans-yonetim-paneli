import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { LOW_STOCK_QUEUE, LowStockService } from './low-stock.service';

/** Tekrarlı düşük stok taramasını çalıştırır (§12). ExpiryProcessor deseniyle aynı. */
@Processor(LOW_STOCK_QUEUE)
export class LowStockProcessor extends WorkerHost {
  constructor(private readonly lowStock: LowStockService) {
    super();
  }

  async process(_job: Job): Promise<{ created: number }> {
    const created = await this.lowStock.checkLowStock();
    return { created };
  }
}
