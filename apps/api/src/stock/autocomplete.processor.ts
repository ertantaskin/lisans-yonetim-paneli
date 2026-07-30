import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { FulfillmentService } from '../orders/fulfillment.service';
import { AUTOCOMPLETE_QUEUE, type AutocompleteJob } from './autocomplete.queue';

/**
 * Stok tamamlama backlog işleyicisi (§5). Import ucu inline olarak yalnız CAP kadar satır
 * tamamlar; DAHA fazlası varsa `{ productId }` işi bu kuyruğa düşer ve burada ARKA PLANDA,
 * SINIRSIZ (maxLines YOK) çalışır → backlog bitene dek. HTTP isteğini bloklamaz.
 *
 * DAVRANIŞ EŞİTLİĞİ: işleyici `autoCompleteProduct`'ı maxLines OLMADAN çağırır → eski (sınırsız)
 * FIFO süpürmesinin BİREBİR aynısı (partial-auto + held-atlama + all-or-nothing + SKIP LOCKED
 * erken-çıkış). Yani arka plan yolu, inline yolun devamıdır; teslimat kararları değişmez.
 * İş idempotent (completeLine FOR UPDATE + SKIP LOCKED): retry veya eşzamanlı işçi çifte teslim etmez.
 */
@Processor(AUTOCOMPLETE_QUEUE)
export class AutocompleteProcessor extends WorkerHost {
  private readonly logger = new Logger(AutocompleteProcessor.name);

  constructor(private readonly fulfillment: FulfillmentService) {
    super();
  }

  async process(job: Job<AutocompleteJob>): Promise<{ completed: number }> {
    const { productId } = job.data;
    if (!productId) {
      // Gövde bozuksa sessizce geçme (kuyruk hijyeni): fırlat → /ops dead-letter'da görünür.
      throw new Error(`autocomplete işinde productId eksik (job=${job.id ?? '-'})`);
    }
    // maxLines VERİLMEZ → sınırsız: kalan backlog tümüyle tamamlanır (arka plan; süre bloklamaz).
    const { completed } = await this.fulfillment.autoCompleteProduct(productId);
    if (completed > 0) {
      this.logger.log(`Arka plan tamamlama: ürün ${productId} için ${completed} satır tamamlandı`);
    }
    return { completed };
  }
}
