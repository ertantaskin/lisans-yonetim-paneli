import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { pgErrorCode } from '../db/pg-error';
import { SentryExceptionFilter } from '../observability/sentry-exception.filter';
import { pgHttpException, pgHttpMapping } from './pg-http-mapping';

/**
 * Global istisna filtresi — ham Postgres hatasını anlamlı bir 4xx/503'e çevirir, sonra
 * `SentryExceptionFilter`'a devreder. Çeviri KURALI (hangi SQLSTATE hangi duruma gider ve
 * NEDEN) ayrı bir saf modüldedir: `common/pg-http-mapping.ts` (birim testli).
 *
 * NEDEN AYRI BİR APP_FILTER OLARAK DEĞİL DE KALITIMLA: Nest birden çok global filtreyi
 * KAYIT SIRASININ TERSİNDEN dener (`createConcreteContext` sonunda `.reverse()`), yani iki
 * catch-all filtre kaydedilirse hangisinin önce çalıştığı framework iç detayına bağlı olurdu.
 * Sıra yanlış olsaydı Sentry filtresi 500'ü render eder, bu filtre HİÇ çalışmazdı — ve bu
 * SESSİZ bir arıza olurdu (bu projede tam olarak bu sınıf hatalar pahalıya mal oldu).
 * Kalıtımla sıra bir framework davranışı değil, kod akışı olur: önce çeviri, sonra Sentry.
 *
 * SENTRY DAVRANIŞI KORUNUR: 4xx'e çevrilen hata artık HttpException olduğu için üst sınıfın
 * "yalnız >=500 raporla" kuralına takılır ve Sentry'ye GİTMEZ — istenen budur (bunlar istemci
 * hatasıdır, sunucu kusuru değil). Çevrilemeyen her şey aynen 500 + Sentry olarak akar.
 */
@Catch()
export class PgExceptionFilter extends SentryExceptionFilter {
  private readonly logger = new Logger(PgExceptionFilter.name);

  constructor(adapterHost: HttpAdapterHost) {
    super(adapterHost);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    // HttpException'lar OLDUĞU GİBİ geçer: 404/409/429 gibi bilinçli yanıtlar ve
    // `SalesQuotaExceededException` gibi özel istisnalar bu filtreden etkilenmez.
    if (exception instanceof HttpException) {
      super.catch(exception, host);
      return;
    }

    const mapping = pgHttpMapping(exception);
    if (!mapping) {
      super.catch(exception, host);
      return;
    }

    // Teşhis izi: SQLSTATE + kısıt adı LOG'a düşer (yanıta DEĞİL — ham PG metni sır/PII
    // taşıyabilir). Bu satır olmasa çeviri, asıl hatayı hem operatörden hem geliştiriciden
    // gizlerdi: 500 kaybolur ama yerine hiçbir iz kalmazdı.
    const rec = exception as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    const constraint = rec.constraint_name ?? rec.constraint;
    this.logger.warn(
      `PG hatası ${String(rec.code ?? pgErrorCode(exception))} → HTTP ${mapping.status}` +
        (constraint ? ` (kısıt: ${String(constraint)})` : ''),
    );

    if (mapping.retryAfterSec != null) this.setRetryAfter(host, mapping.retryAfterSec);
    super.catch(pgHttpException(mapping), host);
  }

  /**
   * `Retry-After` başlığı (saniye). Fastify reply'a istisna RENDER EDİLMEDEN önce yazılır →
   * başlık yanıtta kalır (orders.controller'daki 429 Retry-After deseniyle aynı gerekçe).
   * HTTP olmayan bağlamda (kuyruk işçisi) sessizce atlanır — çeviri yine de geçerlidir.
   */
  private setRetryAfter(host: ArgumentsHost, seconds: number): void {
    try {
      if (host.getType() !== 'http') return;
      const reply = host.switchToHttp().getResponse<{ header?: (k: string, v: string) => void }>();
      reply?.header?.('retry-after', String(seconds));
    } catch {
      // Başlık bir kolaylıktır; yazılamaması yanıtı düşürmemeli.
    }
  }
}
