import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { stdSerializers } from 'pino';
import { SentryExceptionFilter } from './observability/sentry-exception.filter';
import { sanitizeLogUrl } from './observability/log-redact';
import { validateEnv } from './config/env.validation';
import { DbModule } from './db/db.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { CryptoModule } from './crypto/crypto.module';
import { QueueModule } from './queue/queue.module';
import { SitesModule } from './sites/sites.module';
import { AdminUsersModule } from './admin-users/admin-users.module';
import { ProductsModule } from './products/products.module';
import { StockModule } from './stock/stock.module';
import { OrdersModule } from './orders/orders.module';
import { ReplacementsModule } from './replacements/replacements.module';
import { CustomersModule } from './customers/customers.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsModule } from './reports/reports.module';
import { ProcurementModule } from './procurement/procurement.module';
import { SupplierClaimsModule } from './supplier-claims/supplier-claims.module';
import { SupplyOpsModule } from './supply-ops/supply-ops.module';
import { SecurityModule } from './security/security.module';
import { AuditModule } from './audit/audit.module';
import { SearchModule } from './search/search.module';
import { TemplatesModule } from './templates/templates.module';
import { OpsModule } from './ops/ops.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { PresenceModule } from './presence/presence.module';
import { SavedViewsModule } from './saved-views/saved-views.module';
import { UpdatesModule } from './updates/updates.module';
import { DeploymentsModule } from './deployments/deployments.module';
import { AiModule } from './ai/ai.module';
import { AiSupportModule } from './ai/ai-support.module';
import { AiSummaryModule } from './ai/ai-summary.module';
import { AiReportModule } from './ai/ai-report.module';
import { DailyDigestModule } from './ai/daily-digest.module';
import { CostsModule } from './reports/costs.module';
import { RiskScoreModule } from './security/risk-score.module';
import { ChannelModule } from './channel/channel-catalog.module';
import { RateLimitModule } from './common/rate-limit.module';

/**
 * Geliştirmede okunabilir log (pino-pretty), üretimde ham JSON.
 *
 * `pino-pretty` bir devDependency'dir ve prod imajında BULUNMAZ. Yalnız NODE_ENV'e bakmak
 * yetmez: prod imajı NODE_ENV=production dışında bir değerle koşturulduğunda pino transport'u
 * çözemeyip uygulamayı BOOT ETTİRMİYORDU. Modülü gerçekten çözebiliyor muyuz — onu sorarız.
 */
function prettyTransport() {
  if (process.env.NODE_ENV === 'production') return undefined;
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { singleLine: true } };
  } catch {
    return undefined; // kurulu değil → JSON log; servis AYAKTA kalır
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        // `pino-pretty` bir GELİŞTİRME kolaylığıdır ve devDependency'dir. Prod imajı artık
        // prod-only bağımlılıklarla kurulduğu için orada YOKTUR — dolayısıyla varlığı
        // ÇALIŞMA ZAMANINDA denetlenir. Eskiden yalnız NODE_ENV'e bakılıyordu: prod imajı
        // NODE_ENV=production DIŞINDA bir değerle koşturulduğunda (dev/staging stack'i) API
        // "unable to determine transport target for pino-pretty" ile BOOT EDEMİYORDU.
        // Bir log biçimlendiricisinin yokluğu servisi düşürmemeli — yoksa sessizce JSON'a düş.
        transport: prettyTransport(),
        // Trace-Id uçtan uca (§4/§16): genReqId'i main.ts'teki Fastify adapter belirler
        // (gelen x-trace-id → req.id). pino kendi genReqId'i olmadığında Fastify req.id'sini
        // kullanır → log iz-kimliği = yanıt x-trace-id başlığı = tek uçtan uca iz.
        // Payload/sır loglara sızmasın (§9 redaksiyon).
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers["x-api-key"]',
            'req.headers["x-signature"]',
            // ADMIN_TOKEN (denetim bulgusu — CANLIDA doğrulandı: son 1 saatte 30 log satırında
            // DÜZ METİN duruyordu). pino-http `req`i o isteğin HER log satırına bağlar, yani
            // başlık maskelenmezse token tüm admin trafiğiyle birlikte loga akar. Bu token
            // `AdminGuard`ın tek kapısıdır ve `x-admin-role` başlığı gönderilmediğinde
            // `OwnerGuard` da geçirdiği için, log okuma yetkisi TAM panel kontrolüne yükselirdi.
            // NOT: `x-admin-actor` bilerek maskelenmez — operatör kimliği olay müdahalesinde
            // gereklidir ve zaten audit_log'da saklanır (müşteri PII'si DEĞİL).
            'req.headers["x-admin-token"]',
            'req.body.payload',
            // Stok import gövdesi payload'ı DİZİ İÇİNDE taşır ({ items: [{ payload: … }] });
            // skaler 'req.body.payload' yolu bunu KAPSAMAZ → lisans anahtarları loga sızardı.
            // Hem eleman-bazlı wildcard hem de tüm dizi (yeni alan eklenirse de kapalı kalsın).
            'req.body.items[*].payload',
            'req.body.items',
          ],
          remove: true,
        },
        // URL redaksiyonu (§9/KVKK + SEC-2): pino-http varsayılan req serializer'ı req.url'i
        // olduğu gibi loglar. İki değer oraya düşüyordu:
        //   • müşteri e-postası (GET /admin/customers/:email) → PII; anonymize/retention log
        //     tarihçesini KAPSAMAZ, yani silme garantisi delik kalırdı;
        //   • TAM lisans anahtarı (GET /admin/license-items?search=…) → SIR. Envanter araması
        //     bu hafta tam anahtar kabul edecek şekilde genişletildi; `redact.paths` YALNIZ
        //     gövdeyi kapsadığı için anahtar erişim logunda DÜZ METİN duruyordu — payload'lar
        //     AES-256-GCM ile şifreliyken bu, projenin kendi ilkesiyle çelişir.
        // Kural + gerekçe TEK KAYNAK: observability/log-redact.ts (birim testli).
        serializers: {
          req: stdSerializers.wrapRequestSerializer((r) => {
            const rec = r as { url?: unknown };
            if (typeof rec.url === 'string') {
              rec.url = sanitizeLogUrl(rec.url);
            }
            return r;
          }),
        },
      },
    }),
    DbModule,
    RedisModule,
    CryptoModule,
    QueueModule,
    HealthModule,
    SitesModule,
    AdminUsersModule,
    ProductsModule,
    StockModule,
    OrdersModule,
    ReplacementsModule,
    CustomersModule,
    NotificationsModule,
    ReportsModule,
    ProcurementModule,
    SupplyOpsModule,
    SupplierClaimsModule,
    SecurityModule,
    AuditModule,
    SearchModule,
    TemplatesModule,
    OpsModule,
    DashboardModule,
    MaintenanceModule,
    OnboardingModule,
    PresenceModule,
    SavedViewsModule,
    UpdatesModule,
    DeploymentsModule,
    AiModule,
    AiSupportModule,
    AiSummaryModule,
    AiReportModule,
    DailyDigestModule,
    CostsModule,
    RiskScoreModule,
    ChannelModule,
    RateLimitModule,
  ],
  providers: [
    // Global istisna filtresi: 5xx/beklenmeyen hataları Sentry'ye iletir (env-gated; DSN
    // yoksa no-op), sonra Nest varsayılanına devreder → yanıt biçimi değişmez.
    { provide: APP_FILTER, useClass: SentryExceptionFilter },
  ],
})
export class AppModule {}
