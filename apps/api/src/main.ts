import 'reflect-metadata';
// Sentry init'i uygulama modüllerinden ÖNCE çalışmalı (env-gated; DSN yoksa no-op).
import './observability/instrument';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module';

/**
 * Süreç-düzeyi hata kancaları için logger referansı.
 *
 * `bootstrap()` pino logger'ını ancak Nest uygulaması kurulduktan SONRA elde edebilir; oysa
 * kancaların bootstrap SIRASINDA da (ör. modül init'inde reddedilen bir promise) iş görmesi
 * gerekir. Bu yüzden referans modül düzeyinde tutulur ve logger hazır olur olmaz doldurulur;
 * hazır değilse `console.error`'a düşülür (log kaybetmemek, biçimden önemlidir).
 */
let processLogger: Logger | undefined;

/** Aynı anda iki `uncaughtException` gelirse kapanış yordamı iki kez koşmasın. */
let shuttingDown = false;

function logFatal(message: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  if (processLogger) processLogger.fatal(`${message}: ${detail}`);
  else console.error(`[FATAL] ${message}: ${detail}`);
}

/**
 * Süreç-düzeyi hata kancaları (denetim A6).
 *
 * NEDEN VAR: `@nestjs/bullmq`, `@OnWorkerEvent` handler'ını `.catch()` ile SARMADAN bağlar.
 * Böyle bir handler async ise ve reddederse ortaya YAKALANMAMIŞ bir promise reddi çıkar;
 * Node 22'de varsayılan `--unhandled-rejections=throw` bunu `uncaughtException`a çevirir ve
 * kanca yoksa SÜRECİ ÖLDÜRÜR. Bugün bu latent bir risk (dokuz handler'ın hepsi tam try/catch'li
 * `SweepAlarmService.report` çağırıyor) — ama bu, BELGELENMEMİŞ ve TEK NOKTAYA bağlı bir
 * invaryanttır: bir handler'a try/catch'siz tek bir `await` eklemek API'yi sessizce düşürür.
 * Kancalar hem o düşüşü GÖRÜNÜR kılar hem de reddi ölümcül olmaktan çıkarır.
 *
 * İKİ OLAY BİLEREK FARKLI ELE ALINIR:
 *  · `unhandledRejection` → LOGLA, süreci DÜŞÜRME. Reddin kaynağı çoğunlukla izole bir
 *    yan-etkidir (best-effort bildirim, telemetri); sipariş teslimatını servis eden süreci
 *    bunun için öldürmek, arızayı büyütür.
 *  · `uncaughtException` → LOGLA ve KONTROLLÜ ÇIK. Bu noktada süreç TANIMSIZ durumdadır
 *    (yarıda kalmış transaction, tutarsız modül state'i); ayakta tutmak sessiz veri hatası
 *    riskidir. Docker `restart: unless-stopped` ile temiz bir süreç yeniden başlar.
 *
 * NOT: `exit(1)` küçük bir gecikmeyle çağrılır — pino stdout'a tamponlu yazar; hemen çıkmak
 * tam da teşhis için gereken son satırı kaybettirir.
 */
function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    logFatal('YAKALANMAMIŞ promise reddi (süreç ayakta bırakılıyor)', reason);
  });

  process.on('uncaughtException', (err) => {
    logFatal('YAKALANMAMIŞ istisna — süreç kontrollü kapatılıyor (restart bekleniyor)', err);
    if (shuttingDown) return;
    shuttingDown = true;
    // unref() KULLANILMAZ: bu timer olay döngüsünü ayakta tutan tek şey olabilir; unref'lenseydi
    // süreç 0 ile (yani "başarılı") çıkar ve orkestratör arızayı fark etmezdi.
    setTimeout(() => process.exit(1), 250);
  });
}

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
      // requestTimeout — DİKKAT, HANDLER SÜRESİNİ SINIRLAMAZ (denetim A4: yorum yanlış
      // güvence veriyordu, ölçülerek düzeltildi).
      //
      // GERÇEK SEMANTİK (Node `http.Server.requestTimeout`): sayaç, isteğin İSTEMCİDEN
      // TAMAMEN ALINMASI için işler; başlıklar + gövde okunduğu anda timer TEMİZLENİR.
      // Yani koruduğu şey yavaş/askıda İSTEMCİ (Slowloris sınıfı, yarım gönderilmiş gövde),
      // uzun süren HANDLER değil. ÖLÇÜLDÜ: `requestTimeout: 1000` + 3 sn uyuyan handler →
      // `200, 3027 ms` (408 YOK). Bu ayar 30 sn'lik bir "yanıt süresi tavanı" DEĞİLDİR.
      //
      // HANDLER SÜRESİNİN GERÇEK TAVANLARI alt katmanlardan gelir (her biri kendi anlamlı
      // hatasını üretir): Redis `commandTimeout` 2 sn (redis.module) · PG `statement_timeout`
      // 30 sn / `lock_timeout` 10 sn / `connect_timeout` 10 sn (db.module) · SMTP connect 10 sn
      // + socket 20 sn · giden webhook/AI fetch'lerinin kendi timeout'ları.
      //
      // BİLİNEN BOŞLUK (NOT, bilinçli): hiçbir alt katmana değmeyen saf CPU/JS döngüsü ya da
      // timeout'suz bir çağrı için GLOBAL bir yanıt tavanı YOK. Kapsamı büyütmemek için
      // TimeoutInterceptor EKLENMEDİ (istek iptali alt katmanları geri almaz, yalnız yanıtı
      // erken keser → yanıltıcı bir "tamam" duygusu verir). Gerekirse ayrı ele alınmalı.
      //
      // keepAliveTimeout'a DOKUNULMADI (kalıcı bağlantı yeniden kullanımı korunur).
      requestTimeout: 30000,
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
  // Süreç kancaları artık console yerine pino'ya yazsın (JSON log → Sentry/log sorguları görür).
  processLogger = app.get(Logger);

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

  app.get(Logger).log(`Lisans Paneli API :${port} üzerinde ayakta (prefix /v1)`);
}

// Kancalar bootstrap'ten ÖNCE kurulur: modül init'i sırasında oluşan bir redd/istisna da
// (ör. bir onModuleInit) kapsansın. Logger henüz yokken console.error'a düşer.
installProcessGuards();

void bootstrap();
