import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // trustProxy=1: TEK ters-proxy (Caddy) hop'una güven. `true` (tüm zinciri güven) X-Forwarded-For'un
      // EN SOLDAKI (istemci-kontrollü) girişini req.ip yapardı → @Ip() spoof edilebilir, IP-başlı hız
      // sınırları (connect-claim / update / AI) atlatılabilirdi. `1` ile Caddy'nin eklediği en sağdaki
      // giriş (gerçek istemci IP'si) kullanılır; istemcinin öne eklediği sahte girişler yok sayılır.
      // NOT: topoloji tek Caddy hop (CDN yok); önüne başka proxy eklenirse bu sayı güncellenmeli.
      trustProxy: 1,
      bodyLimit: 1_048_576,
      // Trace-Id uçtan uca (§16): req.id = gelen x-trace-id (yoksa üretilir). Bu TEK
      // kimlik hem pino loglarına (pino, kendi genReqId'i yoksa Fastify req.id'sini
      // kullanır) hem de aşağıdaki onSend yanıt başlığına yansır → istek/log/yanıt aynı iz.
      genReqId: (req: IncomingMessage | Http2ServerRequest) => {
        const incoming = req.headers['x-trace-id'];
        // Gelen x-trace-id yalnız GÜVENLİYSE benimsenir: makul uzunluk (<=200) + güvenli
        // karakter kümesi (harf/rakam/tire/alt-tire/nokta). Aksi halde (CRLF/kontrol
        // karakteri, aşırı uzunluk vb.) log/yanıt-başlığı enjeksiyonunu önlemek için
        // rastgele UUID üretilir. Başlık yok/geçersiz → mevcut fallback korunur.
        return typeof incoming === 'string' &&
          incoming.length > 0 &&
          incoming.length <= 200 &&
          /^[A-Za-z0-9._-]+$/.test(incoming)
          ? incoming
          : randomUUID();
      },
    }),
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
