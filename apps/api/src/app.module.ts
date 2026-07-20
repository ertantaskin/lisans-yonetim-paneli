import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.validation';
import { DbModule } from './db/db.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        // Trace-Id uçtan uca (§4). Eklentiden gelen başlığı taşı, yoksa üret.
        genReqId: (req) => {
          const incoming = req.headers['x-trace-id'];
          return typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
        },
        // Payload/sır loglara sızmasın (§9 redaksiyon).
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers["x-api-key"]',
            'req.headers["x-signature"]',
            'req.body.payload',
          ],
          remove: true,
        },
      },
    }),
    DbModule,
    RedisModule,
    HealthModule,
  ],
})
export class AppModule {}
