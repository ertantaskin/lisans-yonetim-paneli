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
import { SalesQuotaGuard } from './sales-quota.guard';

@Module({
  imports: [AuthModule, ProductsModule, MailModule, WebhookModule, SecurityModule],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService, AdminOrdersService, FulfillmentService, SalesQuotaGuard],
  exports: [OrdersService, AdminOrdersService, FulfillmentService],
})
export class OrdersModule {}
