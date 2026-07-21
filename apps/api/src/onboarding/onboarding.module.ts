import { Module } from '@nestjs/common';
import { SitesModule } from '../sites/sites.module';
import { OnboardingAdminController, ConnectController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

/**
 * Onboarding modülü (§14) — tek-seferlik bağlan kodu üret/tüket. SitesModule'den
 * SitesService (rekey/getById) alır; DB/Redis/Crypto global sağlanır.
 */
@Module({
  imports: [SitesModule],
  controllers: [OnboardingAdminController, ConnectController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
