import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { OrdersModule } from '../orders/orders.module';
import { ReplacementsController } from './replacements.controller';
import { AdminReplacementsController } from './admin-replacements.controller';
import { ReplacementsService } from './replacements.service';

/**
 * Değişim/garanti talepleri (§13). Guard'lar AuthModule'den; onay akışında eski atama
 * revoke + yeni atama için OrdersModule'ün AdminOrdersService + FulfillmentService'ini,
 * durum bildirimleri için MailModule'ün MailService'ini kullanır.
 */
@Module({
  imports: [AuthModule, OrdersModule, MailModule],
  controllers: [ReplacementsController, AdminReplacementsController],
  providers: [ReplacementsService],
})
export class ReplacementsModule {}
