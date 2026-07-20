import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MailService, MAIL_QUEUE } from './mail.service';
import { MailProcessor } from './mail.processor';
import { TemplatesService } from './templates.service';

@Module({
  imports: [BullModule.registerQueue({ name: MAIL_QUEUE })],
  providers: [MailService, MailProcessor, TemplatesService],
  exports: [MailService],
})
export class MailModule {}
