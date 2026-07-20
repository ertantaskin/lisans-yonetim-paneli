import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Raporlar modülü (§18). AdminGuard yalnız global ConfigService'e bağlı olduğundan
 * (MaintenanceModule deseni) ek import gerektirmez; controller @UseGuards ile kullanır.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
