import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SupplyOpsController } from './supply-ops.controller';
import { SupplyOpsService } from './supply-ops.service';

/**
 * Tedarik operasyonları modülü (§12): parti geri çekme (recall) + sebepli stok düzeltme.
 * AdminGuard için AuthModule; app.module'e ORKESTRATÖR ekler.
 */
@Module({
  imports: [AuthModule],
  controllers: [SupplyOpsController],
  providers: [SupplyOpsService],
  exports: [SupplyOpsService],
})
export class SupplyOpsModule {}
