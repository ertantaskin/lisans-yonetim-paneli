/**
 * Stok tamamlama (autocomplete) ARKA PLAN kuyruğu — TEK KAYNAK (üretici de tüketici de buradan okur).
 *
 * NEDEN VAR (perf): stok import HTTP isteği içinde `FulfillmentService.autoCompleteProduct`
 * SENKRON çalışıyordu → tüm bekleyen (pending/partial) satırları çekip her biri için AYRI
 * transaction koşuyordu. Küçük backlog'da sorun yok; ama on binlerce bekleyen satırda bu N seri
 * transaction import ucunun HTTP yanıtını DAKİKALARCA bloklar (istek asılır, FPM/işçi tutulur).
 *
 * ÇÖZÜM (bounded-inline + offload): import artık inline olarak EN FAZLA `AUTOCOMPLETE_INLINE_CAP`
 * satır tamamlar (küçük backlog anında biter → hızlı geri bildirim korunur) ve DAHA fazlası varsa
 * kalanı bu kuyruğa atar; işleyici (AutocompleteProcessor) backlog bitene dek sınırsız çalışır.
 * Teslimat/atama mantığı DEĞİŞMEZ — aynı `autoCompleteProduct` yolu (SKIP LOCKED + idempotent +
 * held-atlama + all-or-nothing) yalnız arka plana taşınır → çifte teslimat/veri kaybı riski YOK.
 */

/** BullMQ kuyruk adı. */
export const AUTOCOMPLETE_QUEUE = 'stock-autocomplete';

/** Kuyruktaki tek iş türünün adı (WorkerHost `job.name` ile ayırt eder). */
export const AUTOCOMPLETE_JOB = 'autocomplete-product';

/** İş gövdesi — yalnız hangi ürünün backlog'unun tamamlanacağı. */
export interface AutocompleteJob {
  productId: string;
}

/**
 * İş yeniden-deneme profili.
 *  - attempts/backoff: geçici DB hatasında tekrar dener (autoCompleteProduct idempotent → güvenli).
 *  - removeOnComplete=true: iş bitince ANINDA silinir → `jobId=productId` dedupe kimliği hemen
 *    serbest kalır (aynı ürün yeniden import edilince yeni backlog için tekrar kuyruğa alınabilir).
 *  - removeOnFail=500: kalıcı başarısızlıklar /ops dead-letter'da görünür kalsın (kuyruk hijyeni, §16).
 *
 * DEDUPE (jobId): import her seferinde `queue.add(..., { jobId: productId })` çağırır → aynı ürün
 * için ZATEN kuyrukta/çalışan bir iş varsa BullMQ ikinciyi eklemez (import seli altında yığılma yok).
 * İşleyici sınırsız `autoCompleteProduct` koştuğu için çalışan iş, çalışırken gelen taze stoğu da
 * (satır bazında güncel stok okunur) kapsar → dedupe kaybına yol açmaz.
 */
export const AUTOCOMPLETE_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 500,
} as const;

/** ConfigService anahtarı — inline tamamlanacak azami satır. Yoksa varsayılan. */
export const AUTOCOMPLETE_INLINE_CAP_ENV = 'AUTOCOMPLETE_INLINE_CAP';

/** Inline cap varsayılanı (env yoksa/geçersizse): import ~200 tx'ten fazla sürmez. */
export const AUTOCOMPLETE_INLINE_CAP_DEFAULT = 200;
