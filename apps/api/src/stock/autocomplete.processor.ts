import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { FulfillmentService } from '../orders/fulfillment.service';
import { SweepAlarmService } from '../maintenance/sweep-alarm.service';
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

  constructor(
    private readonly fulfillment: FulfillmentService,
    private readonly alarm: SweepAlarmService,
  ) {
    super();
  }

  async process(job: Job<AutocompleteJob>): Promise<{ completed: number }> {
    const { productId } = job.data;
    if (!productId) {
      // Gövde bozuksa sessizce geçme (kuyruk hijyeni): fırlat → onFailed kritik alarm üretir.
      throw new Error(`autocomplete işinde productId eksik (job=${job.id ?? '-'})`);
    }
    // maxLines VERİLMEZ → sınırsız: kalan backlog tümüyle tamamlanır (arka plan; süre bloklamaz).
    const { completed } = await this.fulfillment.autoCompleteProduct(productId);
    if (completed > 0) {
      this.logger.log(`Arka plan tamamlama: ürün ${productId} için ${completed} satır tamamlandı`);
    }
    return { completed };
  }

  /**
   * İş KALICI olarak patlarsa kritik alarm (dedupe'lu) + logger.error — sweep'lerle aynı desen
   * (§16 "sessiz iş ölümü yok").
   *
   * DENETİM BULGUSU: bu handler EKSİKTİ ve hem bu dosya hem `autocomplete.queue.ts`
   * "kalıcı başarısızlıklar /ops dead-letter'da görünür" DİYORDU — bu YANLIŞ: `/ops`
   * (OpsService.deadLetterPage) yalnız `outbox_events` + `email_log` tablolarını okur, BullMQ'nun
   * başarısız işlerine HİÇ bakmaz. Yani bu kuyruk panelde hiçbir yerde görünmüyordu.
   *
   * NEDEN ÖNEMLİ: import ucu inline olarak yalnız CAP (vars. 200) satır tamamlar; GERİSİ bu işe
   * devredilir. İş kalıcı olarak patlarsa stok GİRİLMİŞ olmasına rağmen bekleyen siparişler
   * teslim edilmez — müşteri lisansını almaz — ve hiçbir alarm çıkmaz. Operatör bunu ancak
   * müşteri şikâyetiyle fark ederdi.
   *
   * YALNIZ SON DENEMEDE: `attempts: 3` + exponential backoff var; ara denemelerde alarm üretmek
   * (sonradan başarılı olan) geçici DB hatalarını kritik alarma çevirirdi. `attemptsMade` son
   * denemede `opts.attempts`e ulaşır → iş GERÇEKTEN ölmüşse alarm çıkar.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<AutocompleteJob>, err: Error): Promise<void> {
    const made = job?.attemptsMade ?? 0;
    const max = job?.opts?.attempts ?? 1;
    if (made < max) {
      this.logger.warn(
        `Arka plan tamamlama denemesi başarısız (${made}/${max}, tekrar denenecek): ${err?.message ?? err}`,
      );
      return;
    }
    await this.alarm.report(AUTOCOMPLETE_QUEUE, job?.name ?? 'autocomplete', err);
  }
}
