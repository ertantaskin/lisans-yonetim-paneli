import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { SupplyOpsController } from './supply-ops.controller';
import { SupplyOpsService } from './supply-ops.service';

/**
 * Tedarik operasyonları modülü (§12/§13): parti geri çekme (recall) + toplu değiştirme
 * + sebepli stok düzeltme. AdminGuard için AuthModule; toplu değiştirme MEVCUT atama
 * makinesini (AdminOrdersService + FulfillmentService) kullandığından OrdersModule
 * import edilir (ikisi de OrdersModule'de export'lu). app.module'e ORKESTRATÖR ekler.
 */
@Module({
  imports: [AuthModule, OrdersModule],
  controllers: [SupplyOpsController],
  providers: [SupplyOpsService],
  exports: [SupplyOpsService],
})
export class SupplyOpsModule {}
