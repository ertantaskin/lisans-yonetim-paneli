import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { MailService, MAIL_QUEUE } from './mail.service';
import { MailProcessor } from './mail.processor';
import { TemplatesService } from './templates.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = new URL(config.getOrThrow<string>('REDIS_URL'));
        return {
          connection: { host: url.hostname, port: Number(url.port || 6379) },
        };
      },
    }),
    BullModule.registerQueue({ name: MAIL_QUEUE }),
  ],
  providers: [MailService, MailProcessor, TemplatesService],
  exports: [MailService],
})
export class MailModule {}
