import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
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
  constructor(private readonly report: AiReportService) {}

  /** Türkçe soruyu SELECT'e çevirir ve salt-okunur çalıştırır → /v1/admin/ai/report. */
  @Post('report')
  run(@Body(new ZodBody(ReportBody)) body: { question: string }): Promise<AiReportResult> {
    return this.report.report(body.question);
  }
}
