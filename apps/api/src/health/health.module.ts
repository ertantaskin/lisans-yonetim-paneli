import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { SystemStatusController } from './system-status.controller';

@Module({
  // AuthModule: /v1/admin/system/status AdminGuard arkasındadır (yapılandırma bayrakları
  // yalnız operatöre; public /v1/health'e KONULMADI — gereksiz bilgi ifşası).
  imports: [AuthModule],
  controllers: [HealthController, SystemStatusController],
  providers: [HealthService],
})
export class HealthModule {}
