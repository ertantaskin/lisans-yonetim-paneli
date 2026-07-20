import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WEBHOOK_QUEUE } from '../webhook/webhook.service';
import { MAIL_QUEUE } from '../mail/mail.service';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';

/**
 * Ops modülü (§16) — dead-letter listesi + replay. Webhook/mail kuyruklarını yalnız
 * PUBLISH için kaydeder (worker'lar kendi modüllerinde; kuyruk adı Redis'te paylaşımlı).
 */
@Module({
  imports: [BullModule.registerQueue({ name: WEBHOOK_QUEUE }, { name: MAIL_QUEUE })],
  controllers: [OpsController],
  providers: [OpsService],
  exports: [OpsService],
})
export class OpsModule {}
