import { Controller, Get, HttpException, HttpStatus, Ip, UseGuards } from '@nestjs/common';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { AI_RL_MAX, AI_RL_WINDOW_SEC, aiRateKey } from './ai-rate-key';
import { AiSummaryService, type DailySummary } from './ai-summary.service';

/**
 * Admin: günlük operasyon özeti (§15). Metrikler her zaman döner; AI açıksa
 * yanıta Türkçe anomali paragrafı eklenir, kapalıysa paragraph=null (503 ATILMAZ).
 * NOT: 'admin/ai' altında @Get('status') AiController'da; farklı path, çakışmaz.
 */
@Controller('admin/ai')
@UseGuards(AdminGuard)
export class AiSummaryController {
  constructor(
    private readonly summary: AiSummaryService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * Günlük metrikler + (AI açıksa) anomali paragrafı.
   *
   * HIZ SINIRI (eksikti): bu uç AI AÇIKKEN her çağrıda bir Anthropic isteği yapar ve önbelleği
   * yoktur → /ai ekranını yenileyen her istek ÜCRETLİ bir çağrıya dönüşüyordu (kardeş AI uçlarının
   * ikisinde de sınır vardı, bunda yoktu). Kova anahtarı aktör başına (`aiRateKey`) — panel
   * çağrıları Next üzerinden proxy'lendiği için IP tüm operatörler için aynıdır.
   *
   * NOT: sınır aşılınca metrikler de dönmez. Kabul edilebilir, çünkü bu ekran otomatik
   * yoklanmıyor (operatör açtığında/yenilediğinde çağrılır) ve dakikada 20 istek geniş bir tavan.
   */
  @Get('daily-summary')
  async dailySummary(@Ip() ip: string, @AdminActor() actor: string): Promise<DailySummary> {
    if (!(await this.rateLimit.hit(aiRateKey('summary', actor, ip), AI_RL_MAX, AI_RL_WINDOW_SEC))) {
      throw new HttpException(
        'Çok fazla AI isteği. Kısa süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.summary.dailySummary();
  }
}
