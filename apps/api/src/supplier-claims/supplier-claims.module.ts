import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { SupplierClaimsController } from './supplier-claims.controller';
import { SupplierClaimsService } from './supplier-claims.service';

/**
 * Tedarikçi değişim fişleri (§12): kusurlu anahtarları tedarikçiye toplu bildir, cevabını takip et.
 *
 * `AuthModule` → AdminGuard. `OrdersModule` → `AdminOrdersService.listQuarantine`: aday sorgusu
 * YENİDEN YAZILMAZ, denetimden geçmiş tek kaynak kullanılır (üç sebep kaynağını coalesce eden,
 * tarih ön-filtresi olan sorgu). İkinci bir tanım yazmak, bu projede "satılmış 6 birim"
 * yanılgısını üreten hatanın aynısı olurdu.
 */
@Module({
  imports: [AuthModule, OrdersModule],
  controllers: [SupplierClaimsController],
  providers: [SupplierClaimsService],
  exports: [SupplierClaimsService],
})
export class SupplierClaimsModule {}
