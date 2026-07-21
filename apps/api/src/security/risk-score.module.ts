import { Module } from '@nestjs/common';
import { RiskScoreController } from './risk-score.controller';
import { RiskScoreService } from './risk-score.service';

/**
 * Müşteri risk skoru modülü (§8/§9) — advisory, SALT-OKUNUR, otomatik eylem YOK.
 * AdminGuard yalnız (global) ConfigService'e bağlıdır → AuthModule import gerekmez
 * (SecurityModule/AiModule deseniyle aynı, self-contained). Migration YOK: mevcut
 * tabloları okur. Orkestratör app.module'e RiskScoreModule ekler.
 */
@Module({
  controllers: [RiskScoreController],
  providers: [RiskScoreService],
  exports: [RiskScoreService],
})
export class RiskScoreModule {}
