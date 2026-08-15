import { Body, Controller, HttpException, HttpStatus, Ip, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { AI_RL_MAX, AI_RL_WINDOW_SEC, aiRateKey } from './ai-rate-key';
import { RateLimitService } from '../common/rate-limit.service';
import { ZodBody } from '../common/zod-validation.pipe';
import { AiReportService, type AiReportResult } from './ai-report.service';

/** Doğal dilde rapor isteği — Türkçe soru (§15 NL→SQL). */
const ReportBody = z.object({ question: z.string().trim().min(3).max(500) });


/**
 * Admin: doğal dilde rapor / NL→SQL (§15). Türkçe soru → AI salt-okunur SELECT üretir →
 * çalıştırılır → SQL + sonuç döner (SQL her zaman gösterilir). AdminGuard (ADMIN_TOKEN)
 * gerektirir. AI kapalıysa 503 (AiUnavailableException) döner; UI yakalar.
 */
@Controller('admin/ai')
@UseGuards(AdminGuard)
export class AiReportController {
  constructor(
    private readonly report: AiReportService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Türkçe soruyu SELECT'e çevirir ve salt-okunur çalıştırır → /v1/admin/ai/report. */
  @Post('report')
  async run(
    @Body(new ZodBody(ReportBody)) body: { question: string },
    @Ip() ip: string,
    @AdminActor() actor: string,
  ): Promise<AiReportResult> {
    if (!(await this.rateLimit.hit(aiRateKey('report', actor, ip), AI_RL_MAX, AI_RL_WINDOW_SEC))) {
      throw new HttpException(
        'Çok fazla AI isteği. Kısa süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.report.report(body.question);
  }
}
