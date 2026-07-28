import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { MailModule } from '../mail/mail.module';
import { WebhookModule } from '../webhook/webhook.module';
import { SecurityModule } from '../security/security.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';
import { FulfillmentService } from './fulfillment.service';
import { PendingLinesController } from './pending-lines.controller';
import { PendingLinesService } from './pending-lines.service';
import { SalesQuotaGuard } from './sales-quota.guard';

// PendingLinesService, ProductsService (resolveMapping) + FulfillmentService (completeLine)
// kullanır. ProductsModule zaten import ediliyor ve ProductsService'i export ediyor; ters yön
// (ProductsModule → OrdersModule) YOK → döngüsel bağımlılık oluşmaz.
@Module({
  imports: [AuthModule, ProductsModule, MailModule, WebhookModule, SecurityModule],
  controllers: [OrdersController, AdminOrdersController, PendingLinesController],
  providers: [
    OrdersService,
    AdminOrdersService,
    FulfillmentService,
    PendingLinesService,
    SalesQuotaGuard,
  ],
  exports: [OrdersService, AdminOrdersService, FulfillmentService, PendingLinesService],
})
export class OrdersModule {}
