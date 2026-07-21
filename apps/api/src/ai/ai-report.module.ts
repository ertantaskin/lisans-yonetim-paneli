import { Module } from '@nestjs/common';
import { AiModule } from './ai.module';
import { AiReportController } from './ai-report.controller';
import { AiReportService } from './ai-report.service';

/**
 * Doğal dilde rapor / NL→SQL modülü (§15). AiModule'ü (AiService + ReadonlySqlService)
 * import eder. Env-gated, VARSAYILAN KAPALI — AI kapalıysa uç 503 döner.
 */
@Module({
  imports: [AiModule],
  controllers: [AiReportController],
  providers: [AiReportService],
})
export class AiReportModule {}
