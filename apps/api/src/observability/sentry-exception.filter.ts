import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { captureError } from './instrument';

/**
 * Global istisna filtresi: yakalanan istisnayı önce Sentry'ye (etkinse) iletir, sonra
 * Nest'in VARSAYILAN davranışına (BaseExceptionFilter) devreder → HTTP yanıt biçimi
 * DEĞİŞMEZ (geriye tam uyumlu). Sentry KAPALIYKEN captureError no-op → davranış aynen korunur.
 *
 * Yalnız GERÇEK sunucu hataları raporlanır: HttpException OLMAYAN (beklenmeyen) hatalar
 * VEYA 5xx durumlu HttpException. 4xx (doğrulama/yetki/404/429 gibi istemci hataları)
 * beklenen akıştır → Sentry gürültüsü olmaması için İLETİLMEZ.
 *
 * İSTİSNA: /v1/health degraded 503'ü bilinçli/BEKLENEN bir 'degraded' sinyalidir (db/redis ping
 * düştü). Uptime monitörü sık yoklar → kesinti sırasında her poll captureException tetikler,
 * Sentry kotasını yakar ve asıl kök-neden hatayı gürültüde gömer. Sağlık probu bu yüzden hariç.
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  constructor(adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500 && !this.isHealthProbe(host)) {
      captureError(exception);
    }
    super.catch(exception, host);
  }

  /** İstek yolu sağlık ucuysa (/health) true — bilinçli degraded 503 Sentry'ye akıtılmaz. */
  private isHealthProbe(host: ArgumentsHost): boolean {
    try {
      const req = host.switchToHttp().getRequest<{ url?: string }>();
      const path = (req?.url ?? '').split('?')[0];
      return path.endsWith('/health');
    } catch {
      return false;
    }
  }
}
