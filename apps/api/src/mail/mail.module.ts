import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailService, MAIL_QUEUE } from './mail.service';
import { MailProcessor } from './mail.processor';
import { MailConfigGuardService } from './mail-config.guard';
import { TemplatesService } from './templates.service';
import { DeliveryMailBuilder } from './delivery-mail.builder';

@Module({
  // NotificationsModule: üretimde SMTP hedefi dev yakalayıcıysa açılışta KRİTİK bildirim
  // üretmek için (sessiz mail arızası guard'ı — mail-config.guard.ts).
  imports: [NotificationsModule, BullModule.registerQueue({ name: MAIL_QUEUE })],
  providers: [
    MailService,
    MailProcessor,
    MailConfigGuardService,
    TemplatesService,
    DeliveryMailBuilder,
  ],
  // DeliveryMailBuilder DIŞA AÇIK: sipariş detayındaki "mail önizleme" (AdminOrdersService)
  // teslimat gövdesini AYNI koddan üretsin diye (ikinci bir render yolu yazılmaz).
  exports: [MailService, DeliveryMailBuilder],
})
export class MailModule {}
