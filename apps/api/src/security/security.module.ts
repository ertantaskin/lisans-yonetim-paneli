import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SECURITY_QUEUE, SecurityService } from './security.service';
import { SecurityProcessor } from './security.processor';
import { ComplianceService } from './compliance.service';
import { SecurityController } from './security.controller';

/** Güvenlik/anomali + KVKK modülü (§5/§9/§15). MaintenanceModule deseniyle aynı. */
@Module({
  imports: [BullModule.registerQueue({ name: SECURITY_QUEUE })],
  controllers: [SecurityController],
  providers: [SecurityService, SecurityProcessor, ComplianceService],
  exports: [SecurityService, ComplianceService],
})
export class SecurityModule {}
