import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { DeliveryTemplatesService } from './templates.service';

/**
 * Teslimat mail şablonları admin modülü (§6/§13). delivery_templates CRUD + önizleme +
 * test-mail. Mail modülünü DÜZENLEMEZ; test maili mevcut SMTP yapılandırmasıyla gönderilir.
 * app.module.ts imports listesine orkestratörce eklenmeli (TemplatesModule).
 */
@Module({
  controllers: [TemplatesController],
  providers: [DeliveryTemplatesService],
  exports: [DeliveryTemplatesService],
})
export class TemplatesModule {}
