import { Module } from '@nestjs/common';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

/**
 * ProcurementModule — tedarik zinciri (§12): tedarikçiler + satın alma emirleri +
 * teslim alma (parti kaydı). DbModule global; guard ConfigService kullanır.
 * app.module'e ORKESTRATÖR ekler.
 */
@Module({
  controllers: [SuppliersController, PurchaseOrdersController],
  providers: [SuppliersService, PurchaseOrdersService],
  exports: [SuppliersService, PurchaseOrdersService],
})
export class ProcurementModule {}
