import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AiSummaryService, type DailySummary } from './ai-summary.service';

/**
 * Admin: günlük operasyon özeti (§15). Metrikler her zaman döner; AI açıksa
 * yanıta Türkçe anomali paragrafı eklenir, kapalıysa paragraph=null (503 ATILMAZ).
 * NOT: 'admin/ai' altında @Get('status') AiController'da; farklı path, çakışmaz.
 */
@Controller('admin/ai')
@UseGuards(AdminGuard)
export class AiSummaryController {
  constructor(private readonly summary: AiSummaryService) {}

  /** Günlük metrikler + (AI açıksa) anomali paragrafı. */
  @Get('daily-summary')
  async dailySummary(): Promise<DailySummary> {
    return this.summary.dailySummary();
  }
}
