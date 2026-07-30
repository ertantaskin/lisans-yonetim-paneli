import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { OrdersModule } from '../orders/orders.module';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { AutocompleteProcessor } from './autocomplete.processor';
import { AUTOCOMPLETE_QUEUE } from './autocomplete.queue';

// AutocompleteProcessor, OrdersModule'ün export ettiği FulfillmentService'e ihtiyaç duyar
// (OrdersModule zaten import ediliyor). Ters yön (OrdersModule → StockModule) YOK → döngü oluşmaz.
// Kuyruk global BullMQ bağlantısına (QueueModule.forRootAsync) registerQueue ile bağlanır
// (mail/low-stock ile aynı desen).
@Module({
  imports: [
    AuthModule,
    ProductsModule,
    OrdersModule,
    BullModule.registerQueue({ name: AUTOCOMPLETE_QUEUE }),
  ],
  controllers: [StockController],
  providers: [StockService, AutocompleteProcessor],
  exports: [StockService],
})
export class StockModule {}
