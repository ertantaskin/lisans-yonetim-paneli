import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * Genel-bakış (dashboard) modülü (§13). ReportsModule deseniyle aynı: AdminGuard
 * yalnız global ConfigService'e bağlı olduğundan ek import gerekmez; controller
 * @UseGuards ile kullanır. Orkestratör app.module.ts'e import eder.
 */
@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
