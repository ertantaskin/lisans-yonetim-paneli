import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { OrdersModule } from '../orders/orders.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { AutocompleteProcessor } from './autocomplete.processor';
import { AUTOCOMPLETE_QUEUE } from './autocomplete.queue';

// AutocompleteProcessor, OrdersModule'ün export ettiği FulfillmentService'e ihtiyaç duyar
// (OrdersModule zaten import ediliyor). Ters yön (OrdersModule → StockModule) YOK → döngü oluşmaz.
// Kuyruk global BullMQ bağlantısına (QueueModule.forRootAsync) registerQueue ile bağlanır
// (mail/low-stock ile aynı desen).
// `NotificationsModule` ZORUNLU: AutocompleteProcessor süpürme-başarısızlık alarmı için
// `SweepAlarmService`'i enjekte ediyor ve o servis oradan export ediliyor (SecurityModule ile
// birebir aynı desen). Eksik olsaydı Nest bağımlılığı çözemez ve **API HİÇ BOOT ETMEZDİ** —
// `tsc` ve `next build` bunu YAKALAMAZ (çalışma anı DI hatası). Döngü yok: Notifications →
// AuthModule zincirinin hiçbir halkası StockModule'ü import etmiyor.
@Module({
  imports: [
    AuthModule,
    ProductsModule,
    OrdersModule,
    NotificationsModule,
    BullModule.registerQueue({ name: AUTOCOMPLETE_QUEUE }),
  ],
  controllers: [StockController],
  providers: [StockService, AutocompleteProcessor],
  exports: [StockService],
})
export class StockModule {}
