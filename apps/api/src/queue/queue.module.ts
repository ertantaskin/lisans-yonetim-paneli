import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';

/**
 * BullMQ kök bağlantısı — tek yerde (§1). Mail ve webhook kuyrukları bunu paylaşır.
 * Global: feature modülleri BullModule.registerQueue ile kuyruk tanımlar.
 */
@Global()
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
  ],
  exports: [BullModule],
})
export class QueueModule {}
