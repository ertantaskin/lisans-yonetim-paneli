import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SweepAlarmService } from '../maintenance/sweep-alarm.service';
import { LOW_STOCK_QUEUE, LowStockService } from './low-stock.service';

/** Tekrarlı düşük stok taramasını çalıştırır (§12). ExpiryProcessor deseniyle aynı. */
@Processor(LOW_STOCK_QUEUE)
export class LowStockProcessor extends WorkerHost {
  constructor(
    private readonly lowStock: LowStockService,
    private readonly alarm: SweepAlarmService,
  ) {
    super();
  }

  async process(_job: Job): Promise<{ created: number }> {
    const created = await this.lowStock.checkLowStock();
    return { created };
  }

  /**
   * İş patlarsa kritik alarm (dedupe'lu) + logger.error — expiry/reconcile/retention ile aynı
   * desen (§16 "sessiz iş ölümü yok").
   *
   * DENETİM BULGUSU: bu handler EKSİKTİ. Düşük stok taraması stok ALARMININ TEK kaynağıdır;
   * sweep sessizce ölürse panel "stok yeterli" gibi görünmeye devam eder (hiçbir low_stock
   * bildirimi üretilmez) ve operatör bunu ancak siparişler pending'e düşünce fark eder.
   * Kalıcı bir arıza (bozuk sorgu/DB baskısı) 30 dakikada bir sessizce tekrarlanırdı.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error): Promise<void> {
    await this.alarm.report(LOW_STOCK_QUEUE, job?.name ?? 'sweep', err);
  }
}
