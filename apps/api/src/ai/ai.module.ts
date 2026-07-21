import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ReadonlySqlService } from './readonly-sql.service';

/**
 * AI-destekli operasyon çekirdeği (§15). AiService (Anthropic Messages API ham istemcisi,
 * env-gated) + ReadonlySqlService (salt-okunur SQL çalıştırma) sağlar; özellik modülleri
 * (triyaj, NL→rapor, günlük anomali) bunu import eder. Env-gated, VARSAYILAN KAPALI.
 */
@Module({
  controllers: [AiController],
  providers: [AiService, ReadonlySqlService],
  exports: [AiService, ReadonlySqlService],
})
export class AiModule {}
