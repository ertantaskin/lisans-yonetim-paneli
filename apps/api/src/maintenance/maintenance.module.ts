import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EXPIRY_QUEUE, ExpiryService } from './expiry.service';
import { ExpiryProcessor } from './expiry.processor';
import { MaintenanceController } from './maintenance.controller';

@Module({
  imports: [BullModule.registerQueue({ name: EXPIRY_QUEUE })],
  controllers: [MaintenanceController],
  providers: [ExpiryService, ExpiryProcessor],
  exports: [ExpiryService],
})
export class MaintenanceModule {}
