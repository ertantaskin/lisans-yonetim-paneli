import { Module } from '@nestjs/common';
import { AiModule } from './ai.module';
import { AiSummaryController } from './ai-summary.controller';
import { AiSummaryService } from './ai-summary.service';

/**
 * Günlük özet + AI anomali paragrafı özelliği (§15). AiModule'ü import ederek
 * çekirdek AiService'e erişir; metrikler DB'den salt-okunur sayılır. Env-gated
 * (AI kapalıysa paragraf null döner, metrikler yine gelir).
 */
@Module({
  imports: [AiModule],
  controllers: [AiSummaryController],
  providers: [AiSummaryService],
  // DailyDigestModule (§16) AiSummaryService'i enjekte eder → export şart.
  exports: [AiSummaryService],
})
export class AiSummaryModule {}
