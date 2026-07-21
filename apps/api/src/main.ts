import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1_048_576 }),
    // rawBody: HMAC imza gövde hash'i için ham istek gövdesi (req.rawBody) gerekli (§4).
    { bufferLogs: true, rawBody: true },
  );

  // pino JSON log (§1 gözlem)
  app.useLogger(app.get(Logger));

  await app.register(helmet, { contentSecurityPolicy: false });

  // v1 sözleşmesi (§4) — tüm uçlar /v1 altında.
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();

  // Trace-Id uçtan uca (§16): her yanıta req.id'yi x-trace-id başlığı olarak
  // yansıt. req.id = genReqId çıktısı (gelen x-trace-id yakalanır, yoksa üretilir),
  // yani istemcinin gönderdiği trace-id echo edilir; göndermeyene üretilen atanır.
  const instance = app.getHttpAdapter().getInstance();
  instance.addHook('onSend', (req, reply, payload, done) => {
    reply.header('x-trace-id', String(req.id));
    done(null, payload);
  });

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });

  app.get(Logger).log(`Jetlisans API :${port} üzerinde ayakta (prefix /v1)`);
}

void bootstrap();
