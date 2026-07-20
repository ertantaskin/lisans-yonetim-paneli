import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { MailModule } from '../mail/mail.module';
import { WebhookModule } from '../webhook/webhook.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';
import { FulfillmentService } from './fulfillment.service';

@Module({
  imports: [AuthModule, ProductsModule, MailModule, WebhookModule],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService, AdminOrdersService, FulfillmentService],
  exports: [OrdersService, AdminOrdersService, FulfillmentService],
})
export class OrdersModule {}
