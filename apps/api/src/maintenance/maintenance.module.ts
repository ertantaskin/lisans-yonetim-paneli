import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EXPIRY_QUEUE, ExpiryService } from './expiry.service';
import { ExpiryProcessor } from './expiry.processor';
import { RECONCILE_QUEUE, ReconcileProcessor, ReconcileService } from './reconcile.service';
import { MaintenanceController } from './maintenance.controller';

@Module({
  imports: [BullModule.registerQueue({ name: EXPIRY_QUEUE }, { name: RECONCILE_QUEUE })],
  controllers: [MaintenanceController],
  providers: [ExpiryService, ExpiryProcessor, ReconcileService, ReconcileProcessor],
  exports: [ExpiryService, ReconcileService],
})
export class MaintenanceModule {}
