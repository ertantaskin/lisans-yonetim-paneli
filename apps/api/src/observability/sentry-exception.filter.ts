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
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  constructor(adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500) {
      captureError(exception);
    }
    super.catch(exception, host);
  }
}
