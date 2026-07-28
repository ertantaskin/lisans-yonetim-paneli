import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { OrdersModule } from '../orders/orders.module';
import { ReplacementsController } from './replacements.controller';
import { AdminReplacementsController } from './admin-replacements.controller';
import { ReplacementsService } from './replacements.service';

/**
 * Değişim/garanti talepleri + destek yazışması (§13). Guard'lar AuthModule'den; onay akışında
 * eski atama revoke + yeni atama için OrdersModule'ün AdminOrdersService + FulfillmentService'ini,
 * durum/yanıt bildirimleri için MailModule'ün MailService'ini kullanır.
 *
 * NOT: suistimal koruması (RateLimitService) ve Redis @Global modüllerden gelir → burada AYRICA
 * import EDİLMEZ. Çözülemezse uygulama BOOT'ta patlar (sessizce "sınırsız" moda düşmez).
 */
@Module({
  imports: [AuthModule, OrdersModule, MailModule],
  controllers: [ReplacementsController, AdminReplacementsController],
  providers: [ReplacementsService],
})
export class ReplacementsModule {}
